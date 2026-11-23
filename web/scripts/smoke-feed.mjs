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
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
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

/** Объявление в любой из схем: у нас <object>, у Яндекса <offer>. */
function countObjects(xml) {
  return (xml.match(/<object |<offer /g) ?? []).length;
}

try {
  const [{ token }] = await q("select token from channel_feeds where channel = 'lalafo'");

  // --- схема канала ---------------------------------------------------------
  // Ненастроенный канал обязан отказать, а не отдать половинчатый фид:
  // объявления, по которым нельзя позвонить, площадке бесполезны, а
  // агентству вредны — оно решит, что выгрузка работает.
  await q("update channel_feeds set contact_phone = null where channel = 'lalafo'");
  const unready = await fetch(`${BASE}/feed/${token}.xml`);
  ok(unready.status === 503, `канал без контакта отказывает (${unready.status})`);
  ok(
    (await unready.text()).includes("телефон"),
    "и говорит, чего не хватает, словами",
  );

  await q(
    "update channel_feeds set contact_phone = '0312 900 900' where channel = 'lalafo'",
  );
  const yandex = await fetch(`${BASE}/feed/${token}.xml`).then((r) => r.text());
  ok(
    yandex.includes('<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">'),
    "канал отдаётся в схеме, которая у него настроена",
  );
  ok(yandex.includes("<phone>+996312900900</phone>"), "контакт агентства в фиде есть");
  ok(
    !yandex.includes("<partner-feed"),
    "и это не наша собственная схема: формат берётся из настройки канала",
  );

  // Наша схема остаётся доступной: её отдают интегратору площадки.
  await q("update channel_feeds set format = 'partner' where channel = 'lalafo'");
  const partner = await fetch(`${BASE}/feed/${token}.xml`).then((r) => r.text());
  ok(partner.includes("<partner-feed"), "смена схемы в данных меняет и фид");
  await q("update channel_feeds set format = 'yandex_realty' where channel = 'lalafo'");
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
  ok(
    xml.includes("<realty-feed") || xml.includes('<partner-feed version="1"'),
    "схема названа своим именем",
  );

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
