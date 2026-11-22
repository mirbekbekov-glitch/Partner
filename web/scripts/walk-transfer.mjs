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
await page.goto(`${BASE}/cabinet/requirements`, { waitUntil: "networkidle" });
const mineClients = await page.locator('a:text("Подбор")').count();
if (mineClients > 0) {
  await page.locator('a:text("Подбор")').first().click();
  await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 20000 });
  const reqUrl = page.url().split("?")[0];
  const client = await page.locator("h1").innerText();
  await page.locator('summary:text("Передать клиента другому агенту")').click();
  await page.locator('select[name="to_agent"]').selectOption({ label: "Чынгыз" });
  await page.locator('button:text("Передать клиента")').click();
  await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
  log(`клиент «${client}» →`, await page.locator(".ok-banner, .act-err").first().innerText());

  await page.goto(reqUrl, { waitUntil: "networkidle" });
  log("у прежнего агента кнопка подбора:",
      await page.locator('button:text("Предложить клиенту")').count(),
      "| предупреждение:", (await page.locator(".warn").count()) > 0);

  await login("chyngyz@partner.kg");
  await page.goto(reqUrl, { waitUntil: "networkidle" });
  log("у нового агента кнопок подбора:",
      await page.locator('button:text("Предложить клиенту")').count());
  await page.screenshot({ path: `${SHOT}/transfer-requirement.png`, fullPage: true });
} else {
  log("клиентов в работе нет — обновите данные");
}

await browser.close();
log("проход завершён");
