// Дымовая проверка пути доступа кабинета.
//
// Проверяется не SQL и не вёрстка, а понижение прав и клеймы: кабинет
// подключается полноправным пользователем и опускается до роли authenticated
// с клеймами вошедшего. Если `set local` однажды перестанет применяться или
// клеймы начнут утекать между запросами по одному соединению из пула, один
// агент увидит данные другого — и никакая построчная политика не поможет,
// потому что политика поверит клеймам.
//
//   node scripts/smoke-cabinet.mjs

import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};

/**
 * Один запрос от имени агента — ровно так, как это делает lib/db.ts.
 *
 * Режим транзакции здесь не мелочь: в «только чтение» запись откажет сама,
 * и проверка прав превратится в проверку режима транзакции. Первая версия
 * этого файла так и ошибалась — отказ приходил со словами «cannot execute
 * UPDATE in a read-only transaction», и выглядело это как успех проверки.
 */
async function asAgent(claims, sql, params = [], mode = "read only") {
  const client = await pool.connect();
  try {
    await client.query(`begin ${mode}`);
    // Тот же пояс, что ставит lib/db.ts: без него «показ в 15:00», введённый
    // агентом, лёг бы в базу как 15:00 UTC, то есть 21:00 по Бишкеку.
    await client.query("set local time zone 'Asia/Bishkek'");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ ...claims, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query(sql, params);
    await client.query("commit");
    return result.rows;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function asAuthService(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role auth_service");
    const result = await client.query(sql, params);
    await client.query("commit");
    return result.rows;
  } finally {
    client.release();
  }
}

try {
  const agents = (
    await pool.query(
      "select full_name, auth_user_id, phone, role from agents where status = 'approved' order by role desc, full_name",
    )
  ).rows;
  const admin = agents.find((a) => a.role === "admin");
  const first = agents.find((a) => a.role === "agent");
  const second = agents.filter((a) => a.role === "agent")[1];
  if (!admin || !first || !second) throw new Error("нужны админ и два агента: примените tests/seed.sql");

  // --- кто я -------------------------------------------------------------
  const me = await asAgent({ sub: first.auth_user_id, phone: first.phone }, "select * from me_v");
  ok(me.length === 1 && me[0].full_name === first.full_name, `вход отдаёт того, кто вошёл (${me[0]?.full_name})`);
  ok(me[0]?.is_admin === false, "обычный агент не администратор");

  // --- клеймы не протекают между запросами -------------------------------
  // Самая опасная ошибка этого слоя: соединение из пула переиспользуется, и
  // если клеймы остались от прошлого запроса, следующий агент увидит чужое.
  const other = await asAgent({ sub: second.auth_user_id, phone: second.phone }, "select * from me_v");
  ok(other[0]?.full_name === second.full_name, `следующий запрос видит своего агента (${other[0]?.full_name})`);

  const noClaims = await pool.query("select current_setting('request.jwt.claims', true) as c");
  ok(!noClaims.rows[0].c, "после транзакции клеймы не остаются на соединении");

  // --- чужое не видно ----------------------------------------------------
  const mineCount = await asAgent(
    { sub: first.auth_user_id, phone: first.phone },
    "select count(*)::int as n from contacts",
  );
  const adminCount = await asAgent(
    { sub: admin.auth_user_id, phone: admin.phone },
    "select count(*)::int as n from contacts",
  );
  ok(
    mineCount[0].n <= adminCount[0].n,
    `агент видит не больше контактов, чем администратор (${mineCount[0].n} против ${adminCount[0].n})`,
  );

  // --- права администратора не достаются агенту --------------------------
  const denied = async (claims, sql, label, mode = "read write") => {
    try {
      await asAgent(claims, sql, [], mode);
      ok(false, `${label} — запрос ПРОШЁЛ`);
    } catch (error) {
      // Причина отказа проверяется явно: «упало» и «упало от прав» — разные
      // вещи, и вторую легко принять за первую.
      ok(
        /FORBIDDEN|permission denied|INVARIANT_1[78]/.test(error.message),
        `${label} (${error.message.slice(0, 60)})`,
      );
    }
  };

  await denied(
    { sub: first.auth_user_id, phone: first.phone },
    `select approve_agent('${admin.auth_user_id}'::uuid)`,
    "агент не одобряет агентов",
  );
  await denied(
    { sub: first.auth_user_id, phone: first.phone },
    "update agents set role = 'admin' where auth_user_id = auth.uid()",
    "агент не назначает себе роль",
  );
  await denied(
    { sub: first.auth_user_id, phone: first.phone },
    "select * from run_maintenance_now()",
    "агент не запускает плановые работы",
  );

  // --- вход --------------------------------------------------------------
  // Проверяется настоящая труба входа: выдача кода, отказ неверному,
  // одноразовость. Именно она открывает систему наружу.
  const issued = await asAuthService("select code, phone from app.issue_login_code($1)", [
    "0777 000 999",
  ]);
  ok(/^\d{6}$/.test(issued[0].code), "код шестизначный");
  ok(issued[0].phone === "+996777000999", `номер приведён к E.164 (${issued[0].phone})`);

  const wrong = await asAuthService("select ok, reason from app.verify_login_code($1, $2)", [
    "0777000999",
    "000000",
  ]);
  ok(wrong[0].ok === false, `неверный код отклонён (${wrong[0].reason})`);

  const right = await asAuthService(
    "select ok, auth_user_id from app.verify_login_code($1, $2)",
    ["0777000999", issued[0].code],
  );
  ok(right[0].ok === true && right[0].auth_user_id, "верный код принят и выдан идентификатор");

  const again = await asAuthService("select ok, reason from app.verify_login_code($1, $2)", [
    "0777000999",
    issued[0].code,
  ]);
  ok(again[0].ok === false, `второй раз тот же код не работает (${again[0].reason})`);

  // --- время показа: пояс агентства -------------------------------------
  // Ошибка была двойной и потому незаметной: введённое время толковалось как
  // UTC, а показывалось тоже в UTC, и «15:00» возвращалось как «15:00».
  // Проверяется не круговорот, а смысл: что база считает это время
  // пятнадцатью часами ПО БИШКЕКУ.
  const bishkek = await asAgent(
    { sub: first.auth_user_id, phone: first.phone },
    `select to_char($1::timestamptz at time zone 'Asia/Bishkek', 'HH24:MI') as local,
            to_char($1::timestamptz at time zone 'UTC',          'HH24:MI') as utc`,
    ["2026-07-15T15:00"],
  );
  ok(bishkek[0].local === "15:00", `введённое 15:00 — это 15:00 по Бишкеку (${bishkek[0].local})`);
  ok(bishkek[0].utc === "09:00", `и 09:00 по UTC (${bishkek[0].utc})`);

  // --- служба входа не достаёт до данных агентства -----------------------
  try {
    await asAuthService("select count(*) from objects");
    ok(false, "служба входа читает объекты — права не ограничены");
  } catch (error) {
    ok(/permission denied/.test(error.message), "служба входа не читает объекты");
  }
} finally {
  await pool.end();
}

console.log(failed === 0 ? "\nдымовая проверка кабинета пройдена" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
