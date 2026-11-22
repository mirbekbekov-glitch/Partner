// Проход по подбору: клиент из обращения, подбор под его условия,
// предложение объекта, назначение и закрытие показа.
//
//   node scripts/walk-matching.mjs
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

// --- клиент из обращения ----------------------------------------------------
await page.goto(`${BASE}/cabinet/inquiries`, { waitUntil: "networkidle" });
const fromInquiry = page.locator('.row:has(a:text("Завести клиента"))').first();
const who = await fromInquiry.locator("h3").innerText();
await fromInquiry.locator('a:text("Завести клиента")').click();
await page.waitForURL("**/requirements/new?inquiry=*", { timeout: 20000 });
log(`форма клиента из обращения «${who.split("\n")[0]}»:`,
    "имя", JSON.stringify(await page.locator('input[name="client_name"]').inputValue()),
    "| телефон", await page.locator('input[name="client_phone"]').inputValue());
await page.screenshot({ path: `${SHOT}/requirement-new.png`, fullPage: true });

// Имя в обращении может отсутствовать — агент выясняет его разговором.
if ((await page.locator('input[name="client_name"]').inputValue()) === "") {
  await page.locator('input[name="client_name"]').fill("Клиент из обращения");
}
await page.locator('select[name="deal_type"]').selectOption("sale");
await page.locator('input[name="budget_min"]').fill("50000");
await page.locator('input[name="budget_max"]').fill("90000");
await page.locator('input[name="zones"]').fill("Центр, Юг");
await page.locator('input[name="rooms"]').fill("1, 2");
await page.locator('button:text("Завести клиента")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 30000 });
const requirementUrl = page.url().split("?")[0];
log("создано →", await page.locator(".ok-banner").first().innerText());

// --- подбор -----------------------------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/matching.png`, fullPage: true });
const fits = await page.locator('h2:text("Подходит")').innerText();
const nearly = (await page.locator('h2:text("Чуть дороже")').count())
  ? await page.locator('h2:text("Чуть дороже")').innerText() : "нет";
log("подбор:", fits.replace(/\n/g, " "), "| чуть дороже:", nearly.replace(/\n/g, " "));

const first = page.locator('.row:has(button:text("Предложить клиенту"))').first();
if ((await first.count()) === 0) throw new Error("подбор ничего не нашёл — проверьте данные");
const offered = await first.locator("h3").innerText();
await first.locator('form:has(button:text("Предложить клиенту")) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log(`предложено «${offered}» →`, await page.locator(".ok-banner, .act-err").first().innerText());

// --- показ -------------------------------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.locator('summary:text("Назначить показ")').first().click();
const when = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
await page.locator('input[name="at"]').first().fill(when);
await page.locator('form:has(input[name="at"]) button').first().click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("показ →", await page.locator(".ok-banner, .act-err").first().innerText());

await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/matching-showing.png`, fullPage: true });

await page.locator('summary:text("Показ прошёл")').first().click();
await page.locator('select[name="outcome"]').first().selectOption("interested");
await page.locator('input[name="reaction"]').first().fill("Понравился вид из окна");
await page.locator('form:has(select[name="outcome"]) button').first().click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("закрытие показа →", await page.locator(".ok-banner, .act-err").first().innerText());

await page.goto(requirementUrl, { waitUntil: "networkidle" });
log("состояния подбора:", (await page.locator(".chip").allInnerTexts()).join(" | "));
await page.screenshot({ path: `${SHOT}/matching-after.png`, fullPage: true });

// --- чужой клиент -------------------------------------------------------------
await page.goto(`${BASE}/cabinet/requirements`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/requirements.png`, fullPage: true });
log("клиентов в списке:", await page.locator(".row").count(),
    "| кнопок «Подбор»:", await page.locator('a:text("Подбор")').count());

await browser.close();
log("проход завершён");
