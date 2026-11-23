// Проход по передаче: объект и клиент уходят другому агенту, права
// переходят вместе с ними.
//
//   node scripts/walk-transfer.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

async function login(email) {
  await page.goto(`${BASE}/cabinet`, { waitUntil: "networkidle" });
  if (await page.locator('button:text("Выйти")').count()) {
    await page.locator('button:text("Выйти")').click();
    await page.waitForURL("**/cabinet/login", { timeout: 20000 });
  }
  await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
  const ask = page.locator("section.card").first();
  await ask.locator('input[name="address"]').fill(email);
  await ask.locator("button").click();
  await page.waitForSelector(".act-ok, .act-err");
  const notice = await page.locator(".act-ok, .act-err").first().innerText();
  const code = notice.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
  const enter = page.locator("section.card").nth(1);
  await enter.locator('input[name="address"]').fill(email);
  await enter.locator('input[name="code"]').fill(code);
  await enter.locator("button").click();
  await page.waitForURL("**/cabinet");
}

// --- объект -----------------------------------------------------------------
await login("aibek@partner.kg");
await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
const mineBefore = await page.locator('.row:has(button:text("Подтвердить актуальность"))').count();
const row = page
  .locator('.row:has(button:text("Подтвердить актуальность")):has(.chip.ok)')
  .first();
const href = await row.locator("h3 a").getAttribute("href");
const address = await row.locator("h3").innerText();
log(`Айбек: своих объектов ${mineBefore}, передаём «${address}»`);

await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
await page.locator('summary:text("Передать объект другому агенту")').click();
await page.screenshot({ path: `${SHOT}/transfer-object.png`, fullPage: true });
const options = await page.locator('select[name="to_agent"] option').allInnerTexts();
log("кому можно передать:", options.filter((o) => !o.includes("выберите")).join(", "));

await page.locator('select[name="to_agent"]').selectOption({ label: "Бакыт" });
await page.locator('button:text("Передать объект")').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("передача →", await page.locator(".ok-banner, .act-err").first().innerText());

await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
log("у прежнего агента кнопка правки:", await page.locator('a:text("Править")').count(),
    "| форма загрузки фото:", await page.locator('input[type="file"]').count());

await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
log("своих объектов стало:", await page.locator('.row:has(button:text("Подтвердить актуальность"))').count());

// --- тот же объект у нового агента --------------------------------------------
await login("bakyt@partner.kg");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
log("у нового агента кнопка правки:", await page.locator('a:text("Править")').count(),
    "| форма загрузки фото:", await page.locator('input[type="file"]').count());
await page.screenshot({ path: `${SHOT}/transfer-object-after.png`, fullPage: true });

// --- клиент ---------------------------------------------------------------------
// Клиент заводится ПРОГОНОМ, а не берётся из списка. Раньше обход отдавал
// Чынгызу первого попавшегося клиента Бакыта: данные разработки таяли с
// каждым прогоном, а когда клиенты кончались, обход уходил в ветку «нет
// клиентов — обновите данные» и проходил, не проверив ничего.
//
// Телефон у прогона свой: клиент ищется по телефону, и с общим номером
// каждый прогон цеплялся бы к контакту первого.
const stamp = String(Date.now()).slice(-6);
const client = `Передача ${stamp}`;
await page.goto(`${BASE}/cabinet/requirements/new`, { waitUntil: "networkidle" });
await page.locator('input[name="client_name"]').fill(client);
await page.locator('input[name="client_phone"]').fill(`0700 ${stamp}`);
await page.locator('select[name="deal_type"]').selectOption("sale");
await page.locator('input[name="budget_min"]').fill("50000");
await page.locator('input[name="budget_max"]').fill("90000");
await page.locator('input[name="zones"]').fill("Центр, Юг");
await page.locator('input[name="rooms"]').fill("1, 2");
await page.locator('button:text("Завести клиента")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 30000 });
const reqUrl = page.url().split("?")[0];

await page.locator('summary:text("Передать клиента другому агенту")').click();
await page.locator('select[name="to_agent"]').selectOption({ label: "Чынгыз" });
// Ждём ОТВЕТА действия: баннера на этой странице ждать нельзя — после
// передачи карточка агенту уже не принадлежит, и возврат идёт в список.
await Promise.all([
  page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
  page.locator('button:text("Передать клиента")').click(),
]);
await page.waitForURL(/\/cabinet\/requirements(\?|$)/, { timeout: 20000 });
const note = await page.locator(".ok-banner, .act-err").first().innerText();
if (!/передан/i.test(note)) throw new Error(`после передачи клиента сказано не то: ${note}`);
log(`клиент «${client}» →`, note);

// Прежний агент карточку больше не открывает.
//
// Проверка нужна именно здесь: возврат после передачи раньше вёл на эту самую
// карточку, и агент попадал на отказ, написанный для витрины, — «Такого
// объекта в каталоге нет. Вернуться в каталог», — а сообщение об успехе
// уезжало в адресную строку и не показывалось никогда.
const lost = await page.goto(reqUrl, { waitUntil: "networkidle" });
if (lost?.status() !== 404) {
  throw new Error(`прежний агент открыл переданного клиента: ${lost?.status()}`);
}
if ((await page.locator('button:text("Предложить клиенту")').count()) !== 0) {
  throw new Error("прежнему агенту предложено работать с переданным клиентом");
}
log("у прежнего агента карточки больше нет (404)");

// Новый — открывает и работает.
await login("chyngyz@partner.kg");
const got = await page.goto(reqUrl, { waitUntil: "networkidle" });
if (got?.status() !== 200) throw new Error(`новый агент клиента не видит: ${got?.status()}`);
const canWork = await page.locator('button:text("Предложить клиенту")').count();
if (canWork === 0) throw new Error("новый агент видит клиента, но работать с ним не может");
log("у нового агента кнопок подбора:", canWork);
await page.screenshot({ path: `${SHOT}/transfer-requirement.png`, fullPage: true });

// --- объект возвращается Айбеку -------------------------------------------------
// Иначе каждый прогон уводил у Айбека по объекту, и данные разработки таяли
// до «передавать нечего». Заодно проверяется обратный путь: принявший агент
// может отдать объект назад.
await login("bakyt@partner.kg");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
await page.locator('summary:text("Передать объект другому агенту")').click();
await page.locator('select[name="to_agent"]').selectOption({ label: "Айбек" });
await Promise.all([
  page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
  page.locator('button:text("Передать объект")').click(),
]);

await login("aibek@partner.kg");
await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
const mineAfter = await page.locator('.row:has(button:text("Подтвердить актуальность"))').count();
if (mineAfter !== mineBefore) {
  throw new Error(`объект не вернулся: было ${mineBefore}, стало ${mineAfter}`);
}
log(`объект вернулся Айбеку: своих объектов снова ${mineAfter}`);

await browser.close();
log("проход завершён");
