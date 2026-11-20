// Дымовая проверка пути доступа к базе.
//
// Проверяется не SQL, а понижение прав. Каталог подключается к базе и
// опускается до роли anon. Если `set local role` однажды перестанет
// применяться, запросы пойдут под правами владельца, и каталог начнёт видеть
// контакты и неопубликованные объекты, ничем себя не выдав. Поэтому здесь
// утверждается обратное: под ролью каталога контакты недоступны.
//
//   node scripts/smoke.mjs

import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const role = process.env.CATALOG_DB_ROLE ?? "anon";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};

// Отказ в правах рвёт транзакцию целиком, поэтому каждая ожидаемая неудача
// идёт в своей точке сохранения — иначе второй запрос упал бы «транзакция
// прервана», и проверка измеряла бы саму себя, а не права роли.
const denied = async (sql, label) => {
  await client.query("savepoint probe");
  try {
    await client.query(sql);
    await client.query("release savepoint probe");
    ok(false, `${label} — запрос ПРОШЁЛ, права не понижены`);
  } catch (error) {
    await client.query("rollback to savepoint probe");
    ok(
      /permission denied|read-only transaction/.test(error.message),
      `${label} (${error.message.slice(0, 52)})`,
    );
  }
};

await client.connect();
try {
  await client.query("begin read only");
  await client.query(`set local role ${role}`);

  const who = await client.query("select current_user");
  ok(who.rows[0].current_user === role, `текущая роль это ${role}`);

  const shown = await client.query("select count(*)::int as n from public_catalog_v");
  ok(shown.rows[0].n > 0, `витрина отдаёт объекты (${shown.rows[0].n})`);

  await denied("select * from contacts limit 1", "контакты недоступны");
  await denied("select * from contact_phones limit 1", "телефоны недоступны");
  await denied("select * from mandates limit 1", "мандаты недоступны");
  await denied("select * from deal_commission_v limit 1", "комиссия недоступна");
  await denied("select * from showings limit 1", "показы недоступны");
  await denied("select * from listing_candidates limit 1", "пул кандидатов недоступен");
  await denied("select * from listing_candidate_phones limit 1", "телефоны кандидатов недоступны");

  // Функции проверяются отдельно от таблиц: право на вызов правами на таблицы
  // не ограничено. Эти три — security definer, то есть исполняются с правами
  // владельца, и RLS их не остановит. До инварианта 15 все три были открыты
  // роли каталога по умолчанию Postgres, и ни один тест этого не замечал.
  await denied("select app.purge_candidates()", "аноним не удаляет кандидатов");
  await denied(
    "select app.upsert_candidate('{\"source\":\"manual\",\"external_id\":\"smoke\"}'::jsonb)",
    "аноним не пишет в пул кандидатов",
  );
  await denied("select app.release_stale_claims()", "аноним не снимает закрепления агентов");

  // objects роли anon выдан, но построчная политика отдаёт только published.
  const objects = await client.query("select count(*)::int as n from objects");
  ok(
    objects.rows[0].n === shown.rows[0].n,
    `из objects видно ровно столько же, сколько в витрине (${objects.rows[0].n})`,
  );

  // Запись запрещена дважды: правами роли и транзакцией только для чтения.
  await denied(
    "insert into objects (kind, deal_type, address, price, created_by_agent_id) values ('flat','sale','x',1,gen_random_uuid())",
    "запись в objects запрещена",
  );

  await client.query("commit");
} finally {
  await client.end();
}

console.log(failed === 0 ? "\nдымовая проверка пройдена" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
