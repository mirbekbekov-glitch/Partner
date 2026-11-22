// Проход по сделке: завести из подбора, посмотреть индикативные суммы,
// закрыть, убедиться, что закрытую не переписать.
//
//   node scripts/walk-deal.mjs
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
  // Выход перед входом: страница входа вошедшего агента уводит в кабинет,
  // и формы на ней нет.
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

await login("bakyt@partner.kg");
log("агент вошёл");

// --- находим свой подбор без сделки -----------------------------------------
await page.goto(`${BASE}/cabinet/requirements`, { waitUntil: "networkidle" });
// Берётся клиент, который ещё в работе: закрытая сделка закрывает и
// потребность, и мандат, поэтому каждый проход съедает один набор данных.
// Это свойство прохода, а не продукта — данные обновляются
// db/dev_seed_cabinet.sql и db/dev_seed.sql.
const withMatch = page
  .locator('.row:has(a:text("Подбор"))')
  .filter({ hasNot: page.locator(".chip.closed, .chip.in_deal") })
  .first();
if ((await withMatch.count()) === 0) {
  throw new Error("нет клиентов в работе — обновите данные: psql -d partner -f db/dev_seed.sql");
}
await withMatch.locator('a:text("Подбор")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 20000 });
const requirementUrl = page.url().split("?")[0];

// Если клиенту ещё ничего не предложено — предлагаем.
if ((await page.locator('button:text("Завести сделку")').count()) === 0) {
  const first = page.locator('.row:has(button:text("Предложить клиенту"))').first();
  if ((await first.count()) === 0) throw new Error("подбор пуст — проверьте данные");
  await first.locator('form:has(button:text("Предложить клиенту")) button').click();
  await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
  await page.goto(requirementUrl, { waitUntil: "networkidle" });
}

// --- заводим сделку ----------------------------------------------------------
await page.locator('form:has(button:text("Завести сделку")) button').first().click();
await page.waitForURL(/\/cabinet\/deals\/[0-9a-f-]{36}/, { timeout: 30000 });
const dealUrl = page.url().split("?")[0];
log("сделка заведена →", await page.locator(".ok-banner").first().innerText());
await page.screenshot({ path: `${SHOT}/deal-open.png`, fullPage: true });

const facts = await page.locator(".facts").allInnerTexts();
log("деньги до закрытия:", facts.join(" | ").replace(/\n/g, " ").slice(0, 190));

// --- закрываем ----------------------------------------------------------------
await page.locator('input[name="final_price"]').fill("95000");
await page.locator('form:has(input[name="final_price"]) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 25000 });
log("закрытие →", await page.locator(".ok-banner, .act-err").first().innerText());

await page.goto(dealUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/deal-closed.png`, fullPage: true });
log("состояние:", (await page.locator(".chip").allInnerTexts()).join(" | "));
log("деньги после закрытия:",
    (await page.locator(".facts").allInnerTexts()).join(" | ").replace(/\n/g, " ").slice(0, 190));
log("кнопка закрытия исчезла:", (await page.locator('button:text("Закрыть сделку")').count()) === 0);

// --- что стало с объектом и клиентом -------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
log("состояния подбора после сделки:",
    (await page.locator(".chip").allInnerTexts()).join(" | "));

// --- чужая сделка ---------------------------------------------------------------
await page.goto(`${BASE}/cabinet/deals`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/deals.png`, fullPage: true });
log("сделок в списке:", await page.locator(".row").count(),
    "| кнопок «Открыть»:", await page.locator('a:text("Открыть")').count());

await login("chyngyz@partner.kg");
await page.goto(dealUrl, { waitUntil: "networkidle" });
log("чужой агент видит сделку:", await page.locator("h1").innerText(),
    "| кнопок закрытия:", await page.locator('button:text("Закрыть сделку")').count(),
    "| предупреждение:", (await page.locator(".warn").count()) > 0);

await browser.close();
log("проход завершён");
