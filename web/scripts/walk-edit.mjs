// Проход по правке: объект, договор, ставка, собственник, условия клиента.
//
//   node scripts/walk-edit.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
const BASE = "http://localhost:3000";
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

async function save(label) {
  await page.locator(`button:text("${label}")`).click();
  await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
  return (await page.locator(".ok-banner, .act-err").first().innerText()).replace(/\n/g, " ");
}

await login("aibek@partner.kg");
log("агент вошёл");

// --- свой объект --------------------------------------------------------------
await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
// Нужен свой объект С ДОГОВОРОМ: у объекта без договора разделов «Договор»
// и «Ставка» на правке нет — и правильно, что нет.
const row = page
  .locator('.row:has(button:text("Подтвердить актуальность")):has(.chip.ok)')
  .first();
const href = await row.locator("h3 a").getAttribute("href");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const priceBefore = await page.locator(".row-price").first().innerText();
log("объект:", await page.locator("h1").innerText(), "| цена была", priceBefore);

await page.locator('a:text("Править")').click();
await page.waitForURL("**/edit", { timeout: 20000 });
await page.screenshot({ path: `${SHOT}/edit-object.png`, fullPage: true });
log("разделов правки:", await page.locator("form.card h2").count(),
    "→", (await page.locator("form.card h2").allInnerTexts()).join(", "));

await page.locator('input[name="price"]').fill("123000");
await page.locator('textarea[name="description"]').fill("Окна во двор, тихо");
log("объект →", await save("Сохранить объект"));

await page.goto(`${BASE}${href}/edit`, { waitUntil: "networkidle" });
await page.locator('input[name="valid_to"]').fill("2027-06-30");
await page.locator('input[name="contract_confirmed"]').check();
log("договор →", await save("Сохранить договор"));

await page.goto(`${BASE}${href}/edit`, { waitUntil: "networkidle" });
await page.locator('input[name="percent"]').fill("30");
log("ставка →", await save("Сохранить ставку"));

await page.goto(`${BASE}${href}/edit`, { waitUntil: "networkidle" });
await page.locator('input[name="name"]').fill("Орозов Азамат");
await page.locator('input[name="phone"]').fill("0700 99 11 22");
log("собственник →", await save("Сохранить собственника"));

await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
log("цена стала:", await page.locator(".row-price").first().innerText(),
    "| подтверждено:", (await page.locator(".chip").allInnerTexts()).join(" | "));
await page.screenshot({ path: `${SHOT}/edit-object-after.png`, fullPage: true });

// --- клиент ---------------------------------------------------------------------
// Другим агентом: подбор ведёт тот, кто завёл потребность (инвариант 20), и
// в приёмочных данных клиенты у Бакыта.
await login("bakyt@partner.kg");
await page.goto(`${BASE}/cabinet/requirements`, { waitUntil: "networkidle" });
if (await page.locator('a:text("Подбор")').count()) {
  await page.locator('a:text("Подбор")').first().click();
  await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 20000 });
  const reqUrl = page.url().split("?")[0];
  const fitsBefore = await page.locator('h2:text("Подходит")').innerText();
  await page.locator('a:text("Править условия")').click();
  await page.waitForURL("**/edit", { timeout: 20000 });
  await page.screenshot({ path: `${SHOT}/edit-requirement.png`, fullPage: true });
  await page.locator('input[name="budget_max"]').fill("200000");
  await page.locator('input[name="zones"]').fill("");
  log("условия →", await save("Сохранить условия"));
  await page.goto(reqUrl, { waitUntil: "networkidle" });
  log("подбор был:", fitsBefore.replace(/\n/g, " "),
      "→ стал:", (await page.locator('h2:text("Подходит")').innerText()).replace(/\n/g, " "));
} else {
  log("клиентов в работе нет — обновите данные");
}

// --- чужой объект -----------------------------------------------------------------
await login("chyngyz@partner.kg");
await page.goto(`${BASE}${href}/edit`, { waitUntil: "networkidle" });
log("чужой агент на правке:", await page.locator("h1").innerText(),
    "| форм:", await page.locator("form.card").count());

await browser.close();
log("проход завершён");
