// Дымовая проверка выгрузки на площадки.
//
//   node scripts/smoke-feed.mjs
//
// Проверяется не вёрстка фида, а главное свойство инварианта 28: фид — это
// каталог. Объект, снятый с публикации, обязан исчезнуть из фида немедленно,
// без всякой синхронизации, а обращение за фидом — попасть в журнал.
//
// Нужен поднятый сервер и засеянная база разработки.
import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

function countObjects(xml) {
  return (xml.match(/<object /g) ?? []).length;
}

try {
  const [{ token }] = await q("select token from channel_feeds where channel = 'lalafo'");
  const [{ n: inFeed }] = await q(
    "select count(*)::int as n from app.channel_feed('lalafo')",
  );

  const response = await fetch(`${BASE}/feed/${token}.xml`);
  ok(response.status === 200, `фид отдаётся (${response.status})`);
  ok(
    (response.headers.get("content-type") ?? "").includes("application/xml"),
    "отдаётся как XML",
  );

  const xml = await response.text();
  ok(countObjects(xml) === inFeed, `в фиде ${countObjects(xml)} объектов, в базе ${inFeed}`);
  ok(xml.includes('<partner-feed version="1"'), "схема названа своим именем");

  // Телефонов в фиде нет не потому, что мы их вырезаем, а потому, что их нет
  // в публичном каталоге. Проверяется по живому фиду, а не по намерению.
  const phones = await q("select phone from contact_phones limit 20");
  ok(
    phones.every((p) => !xml.includes(p.phone.replace("+", ""))),
    "ни одного телефона собственника в фиде",
  );

  // Главное свойство: членство считается, а не хранится.
  const [victim] = await q(
    `select c.id, c.address from app.channel_feed('lalafo') c limit 1`,
  );
  await q("update objects set publication_state = 'withdrawn' where id = $1", [victim.id]);
  const after = await fetch(`${BASE}/feed/${token}.xml`).then((r) => r.text());
  ok(!after.includes(victim.id), `снятый объект исчез из фида сразу (${victim.address})`);
  ok(countObjects(after) === inFeed - 1, "и ровно один, а не все");

  await q("update objects set publication_state = 'published' where id = $1", [victim.id]);
  const back = await fetch(`${BASE}/feed/${token}.xml`).then((r) => r.text());
  ok(back.includes(victim.id), "вернули в каталог — вернулся в фид");

  // Каждое обращение попадает в журнал: без этого «мы отдаём» ничем не
  // отличается от «мы думаем, что отдаём».
  const [{ n: fetches }] = await q(
    "select count(*)::int as n from channel_fetches where channel = 'lalafo'",
  );
  ok(fetches >= 3, `обращения записаны в журнал (${fetches})`);

  // Чужая ссылка не отдаёт ничего.
  const bad = await fetch(`${BASE}/feed/${"0".repeat(64)}.xml`);
  ok(bad.status === 404, `неизвестный токен отвечает 404 (${bad.status})`);
} finally {
  await pool.end();
}

console.log(failed === 0 ? "\nдымовая проверка выгрузки пройдена" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
