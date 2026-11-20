// Проход по уведомлениям: выпуск, отправка, поправка после переноса.
//
//   node scripts/walk-notifications.mjs
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

await login("bakyt@partner.kg");
log("агент вошёл");

await page.goto(`${BASE}/cabinet/notifications`, { waitUntil: "networkidle" });
log("разделы:", (await page.locator("h2").allInnerTexts()).map((t) => t.replace(/\n/g, " ")).join(" / "));
log("всего строк:", await page.locator(".row").count());
for (const text of (await page.locator(".row .note").allInnerTexts()).slice(0, 4)) {
  log("  •", text);
}
log("состояния:", (await page.locator(".row-state .chip").allInnerTexts()).join(", "));
await page.screenshot({ path: `${SHOT}/notifications.png`, fullPage: true });

// --- переносим показ и смотрим, что система поправится ----------------------
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
// Берём предстоящий показ, а не просроченный: переносить прошлое можно, но
// история про поправку читается на будущем.
const card = page.locator(".row.showing:not(.late)").first();
const where = await card.locator("h3").innerText();
const at = await card.locator("time").getAttribute("datetime");
const moved = at.slice(0, 11) + "19:30";
log(`переношу «${where}» с ${at} на ${moved}`);
await card.locator('summary:text("Перенести")').click();
const form = card.locator('details:has(summary:text("Перенести")) form');
await form.locator('input[name="at"]').fill(moved);
await form.locator("button").click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("база сказала:", (await page.locator(".ok-banner, .act-err").first().innerText()).replace(/\n/g, " "));

await page.goto(`${BASE}/cabinet/notifications`, { waitUntil: "networkidle" });
const bodies = await page.locator(".row .note").allInnerTexts();
const fix = bodies.find((t) => /перенес/i.test(t));
log("поправка:", fix ?? "НЕ НАЙДЕНА");
const voided = await page.locator(".row:has(.chip.warn)").count();
log("погашено строк:", voided);
await page.screenshot({ path: `${SHOT}/notifications-fix.png`, fullPage: true });

await browser.close();
log("проход завершён");
