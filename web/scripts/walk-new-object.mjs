// Проход по заведению объекта: пустая форма, форма из объявления, отказы.
//
//   node scripts/walk-new-object.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

import { readFileSync } from "node:fs";
import pg from "pg";

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

// --- вход ------------------------------------------------------------------
await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
const ask = page.locator("section.card").first();
await ask.locator('input[name="address"]').fill("aibek@partner.kg");
await ask.locator("button").click();
await page.waitForSelector(".act-ok, .act-err");
const notice = await page.locator(".act-ok, .act-err").first().innerText();
const code = notice.match(/\b(\d{6})\b/)?.[1];
if (!code) throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
const enter = page.locator("section.card").nth(1);
await enter.locator('input[name="address"]').fill("aibek@partner.kg");
await enter.locator('input[name="code"]').fill(code);
await enter.locator("button").click();
await page.waitForURL("**/cabinet");
log("агент вошёл");

const countObjects = async () => {
  await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
  return page.locator('.row:has(button:text("Подтвердить актуальность"))').count();
};
const before = await countObjects();
log("своих объектов до:", before);

// --- пустая форма ----------------------------------------------------------
await page.goto(`${BASE}/cabinet/objects/new`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/new-object.png`, fullPage: true });
log("форма открыта:", await page.locator("h1").innerText());

// Отказ: собственник не указан.
//
// Отказ приходит ОТ БРАУЗЕРА, а не от базы: поля собственника помечены
// required, и форма не уходит вовсе. Это лучше хода до сервера и обратно, и
// это то, что видит агент.
//
// Прежняя редакция ждала здесь баннера `.act-err` от действия и висела до
// таймаута. Проверка была красной не потому, что продукт сломан, а потому
// что отказ ждали не с той стороны. Отказ базы на этот счёт никуда не делся
// и закреплён инвариантом 19 — повторять его проходом незачем.
const formUrl = page.url();
await page.locator('input[name="address"]').fill("Токтогула 100, кв. 5");
await page.locator('input[name="price"]').fill("72000");
await page.locator("button:text(\"Завести объект\")").click();
await page.waitForTimeout(1500);

const owner = await page.locator('input[name="owner_name"]').evaluate((el) => ({
  valid: el.checkValidity(),
  message: el.validationMessage,
}));
if (owner.valid) {
  throw new Error(
    "форма ушла без собственника: браузер не остановил её, и узнала бы об этом последней база",
  );
}
if (page.url() !== formUrl || (await page.locator(".ok-banner").count()) > 0) {
  throw new Error("форма всё-таки отправилась, хотя собственник не указан");
}
log("без собственника →", owner.message || "браузер не отпустил форму");

// Теперь с собственником.
await page.locator('input[name="owner_name"]').fill("Жаныбек Осмонов");
await page.locator('input[name="owner_phone"]').fill("0700 55 44 33");
await page.locator('select[name="kind"]').selectOption("flat");
await page.locator('input[name="rooms"]').fill("2");
await page.locator('input[name="area"]').fill("56.5");
await page.locator('input[name="zone"]').fill("Центр");
await page.locator('input[name="contract_confirmed"]').check();
await page.locator("button:text(\"Завести объект\")").click();
await page.waitForURL(/\/cabinet\/objects\/[0-9a-f-]{36}/, { timeout: 30000 });
log("создано →", await page.locator(".ok-banner").first().innerText());
log("карточка:", await page.locator("h1").innerText());
await page.screenshot({ path: `${SHOT}/new-object-created.png`, fullPage: true });

const chips = await page.locator(".chip").allInnerTexts();
log("состояние нового объекта:", chips.join(" | "));
log("форма загрузки фотографий на месте:", await page.locator('input[type="file"]').count() === 1);

// --- из объявления ----------------------------------------------------------
// Объявление для прогона заводится ПРОГОНОМ.
//
// Каждый прогон разбирает одно объявление, и пул из db/dev_seed_cabinet.sql
// кончался. Раньше обход на этом месте печатал «пополните данные» и выходил
// с успехом — то есть половина прохода молча не выполнялась, а строка
// «проход завершён» даже не печаталась. Выглядело это то как падение, то как
// успех, в зависимости от того, что осталось в базе.
//
// Заводится тем же путём, что в бою: функцией приёма от имени роли сборщика.
const stamp = String(Date.now()).slice(-6);
const title = `Проба обхода ${stamp}, 2-комн. 54 м²`;
{
  const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const dbUrl = envText.match(/^DATABASE_URL=(.*)$/m)?.[1];
  if (!dbUrl) throw new Error("DATABASE_URL не найден в web/.env");
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("set role collector");
  await db.query("select app.upsert_candidate($1::jsonb)", [JSON.stringify({
    source: "house_kg",
    external_id: `WALK-${stamp}`,
    url: `https://www.house.kg/details/walk-${stamp}`,
    title,
    description: "Объявление для прогона обхода. Телефон выдуманный.",
    address: "город Бишкек, 7 м-н",
    zone: "7 м-н", kind: "flat", deal_type: "sale",
    rooms: 2, area: 54, floor: 4, floors_total: 9,
    price: 4700000, currency: "KGS",
    photos_count: 8, author: "owner", phone: `0700 ${stamp}`,
  })]);
  await db.end();
  log("объявление для прогона заведено:", title);
}

await page.goto(`${BASE}/cabinet/candidates`, { waitUntil: "networkidle" });
const free = page
  .locator(`.row:has(button:text("Взять в работу")):has-text(${JSON.stringify(stamp)})`)
  .first();
if ((await free.count()) === 0) {
  throw new Error(`объявление «${title}» заведено, но в пуле его нет`);
}
await Promise.all([
  page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
  free.locator('form:has(button:text("Взять в работу")) button').click(),
]);
await page.goto(`${BASE}/cabinet/candidates`, { waitUntil: "networkidle" });
log("взято в работу:", title);

const mine = page
  .locator(`.row:has(a:text("Завести объект")):has-text(${JSON.stringify(stamp)})`)
  .first();
if ((await mine.count()) === 0) {
  throw new Error("взятое в работу объявление не предлагает завести объект");
}
await mine.locator('a:text("Завести объект")').click();
await page.waitForURL("**/objects/new?candidate=*", { timeout: 20000 });
await page.screenshot({ path: `${SHOT}/new-object-from-candidate.png`, fullPage: true });
log(`форма из объявления «${title.slice(0, 40)}»:`,
    "адрес", JSON.stringify(await page.locator('input[name="address"]').inputValue()),
    "| цена", await page.locator('input[name="price"]').inputValue(),
    "| телефон", await page.locator('input[name="owner_phone"]').inputValue());

await page.locator('input[name="owner_name"]').fill("Собственник из объявления");
await page.locator("button:text(\"Завести объект\")").click();
await page.waitForURL(/\/cabinet\/objects\/[0-9a-f-]{36}/, { timeout: 30000 });
log("создано из объявления:", await page.locator("h1").innerText());

await page.goto(`${BASE}/cabinet/candidates`, { waitUntil: "networkidle" });
log("объявление исчезло из пула:",
    !(await page.locator(".rows").first().innerText()).includes(title.slice(0, 20)));

log("своих объектов стало:", await countObjects(), "было:", before);

await browser.close();
log("проход завершён");
