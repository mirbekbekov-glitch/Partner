// Проход по заведению объекта: пустая форма, форма из объявления, отказы.
//
//   node scripts/walk-new-object.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
const BASE = "http://localhost:3000";
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
await page.locator('input[name="address"]').fill("Токтогула 100, кв. 5");
await page.locator('input[name="price"]').fill("72000");
await page.locator("button:text(\"Завести объект\")").click();
await page.waitForSelector(".act-err, .ok-banner", { timeout: 20000 });
log("без собственника →", await page.locator(".act-err").first().innerText());

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
await page.goto(`${BASE}/cabinet/candidates`, { waitUntil: "networkidle" });
const free = page.locator('.row:has(button:text("Взять в работу"))').first();
if ((await free.count()) === 0) {
  // Каждый проход разбирает одно объявление, и пул кончается. Это свойство
  // прохода, а не продукта: объявления приносит сборщик, а в разработке —
  // db/dev_seed_cabinet.sql.
  log("свободных объявлений в пуле нет — пополните: psql -d partner -f db/dev_seed_cabinet.sql");
  await browser.close();
  process.exit(0);
}
await free.locator('form:has(button:text("Взять в работу")) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("взято в работу →", await page.locator(".ok-banner, .act-err").first().innerText());

await page.goto(`${BASE}/cabinet/candidates`, { waitUntil: "networkidle" });
const mine = page.locator('.row:has(a:text("Завести объект"))').first();
const title = await mine.locator("h3").innerText();
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
