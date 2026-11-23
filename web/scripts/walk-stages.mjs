// Проход по этапам сделки: задаток → документы → подписание → расчёт,
// возврат назад, застрявшая сделка в отчёте.
//
//   node scripts/walk-stages.mjs
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

async function move(label) {
  await page.locator(`button:text("→ ${label}")`).click();
  await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
  return (await page.locator(".ok-banner, .act-err").first().innerText()).replace(/\n/g, " ");
}

await login("bakyt@partner.kg");
log("агент вошёл");

// --- свой клиент, из подбора которого заводится сделка ------------------------
// Клиент заводится ПРОГОНОМ, а не берётся из списка. Закрытая сделка закрывает
// и потребность, и мандат, поэтому каждый прогон съедал один набор данных; а
// когда первой в списке оказывалась потребность с пустым подбором, обход падал
// с «подбор пуст — обновите данные», будто сломан продукт.
//
// Условия те же, под которыми walk-matching находит варианты. Телефон свой:
// клиент ищется по телефону, и с общим номером прогон цеплялся бы к контакту
// предыдущего.
const stamp = String(Date.now()).slice(-6);
await page.goto(`${BASE}/cabinet/requirements/new`, { waitUntil: "networkidle" });
await page.locator('input[name="client_name"]').fill(`Этапы ${stamp}`);
await page.locator('input[name="client_phone"]').fill(`0700 ${stamp}`);
await page.locator('select[name="deal_type"]').selectOption("sale");
await page.locator('input[name="budget_min"]').fill("50000");
await page.locator('input[name="budget_max"]').fill("90000");
await page.locator('input[name="zones"]').fill("Центр, Юг");
await page.locator('input[name="rooms"]').fill("1, 2");
await page.locator('button:text("Завести клиента")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 30000 });
const reqUrl = page.url().split("?")[0];
log("клиент для прогона заведён:", `Этапы ${stamp}`);

{
  const first = page.locator('.row:has(button:text("Предложить клиенту"))').first();
  if ((await first.count()) === 0) {
    throw new Error("подбор пуст под теми же условиями, под которыми walk-matching находит варианты");
  }
  // Ждём ОТВЕТА действия, а не баннера: баннер «Потребность заведена» уже на
  // экране, и ожидание возвращалось бы мгновенно — страница перечиталась бы
  // раньше, чем действие сработает.
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
    first.locator('form:has(button:text("Предложить клиенту")) button').click(),
  ]);
  await page.goto(reqUrl, { waitUntil: "networkidle" });
}
await page.locator('form:has(button:text("Завести сделку")) button').first().click();
await page.waitForURL(/\/cabinet\/deals\/[0-9a-f-]{36}/, { timeout: 30000 });
const dealUrl = page.url().split("?")[0];
log("сделка заведена:", await page.locator("h1").innerText());

// --- этапы --------------------------------------------------------------------
await page.goto(dealUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/stages-deposit.png`, fullPage: true });
log("этапы на экране:", (await page.locator(".stage strong").allInnerTexts()).join(" → "));
log("текущий:", await page.locator(".stage.now strong").innerText(),
    "|", await page.locator(".stage.now em").innerText());

for (const stage of ["Документы", "Подписание", "Расчёт"]) {
  await page.goto(dealUrl, { waitUntil: "networkidle" });
  log(`${stage} →`, await move(stage));
}

await page.goto(dealUrl, { waitUntil: "networkidle" });
log("пройдено этапов:", await page.locator(".stage.done").count(),
    "| текущий:", await page.locator(".stage.now strong").innerText());
await page.screenshot({ path: `${SHOT}/stages-settlement.png`, fullPage: true });

// Назад: на расчёте выяснилось, что нужен ещё документ.
log("назад к документам →", await move("Документы"));
await page.goto(dealUrl, { waitUntil: "networkidle" });
log("после возврата текущий:", await page.locator(".stage.now strong").innerText(),
    "| пройдено:", await page.locator(".stage.done").count());

// --- застрявшая сделка ---------------------------------------------------------
const dealId = dealUrl.split("/").pop();
log("сделка:", dealId);

await browser.close();
log("проход завершён");
