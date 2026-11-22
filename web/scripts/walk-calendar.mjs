// Проход по календарю показов: неделя, переходы, столкновение у двери.
//
//   node scripts/walk-calendar.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
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

await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
log("переключатель вида:", (await page.locator(".views").innerText()).replace(/\n/g, " / "));

await page.locator('.views a:text("Неделя")').click();
await page.waitForURL("**/showings/week");
log("неделя:", (await page.locator(".weeknav strong").innerText()));

const hours = await page.locator(".cal-hour").allInnerTexts();
log("сетка часов:", hours[0], "—", hours[hours.length - 1], `(${hours.length} строк)`);
log("дни:", (await page.locator(".cal-head strong").allInnerTexts()).join(" "));
log("показов в сетке:", await page.locator(".slot").count(),
    "| своих:", await page.locator(".slot.mine").count(),
    "| чужих:", await page.locator(".slot.theirs").count());

const clash = page.locator(".slot.clash").first();
if (await clash.count()) {
  log("столкновение:", (await clash.innerText()).replace(/\n/g, " · "));
  log("предупреждение:", (await page.locator(".act-err").first().innerText()).replace(/\n/g, " "));
}
await page.screenshot({ path: `${SHOT}/calendar-week.png`, fullPage: true });

// --- переходы по неделям -----------------------------------------------------
await page.locator('.weeknav a:text("Следующая")').click();
await page.waitForLoadState("networkidle");
log("следующая:", await page.locator(".weeknav strong").innerText(),
    "| показов:", await page.locator(".slot").count());

await page.locator('.weeknav a:text("Прошлая")').click();
await page.waitForLoadState("networkidle");
await page.locator('.weeknav a:text("Прошлая")').click();
await page.waitForLoadState("networkidle");
log("прошлая:", await page.locator(".weeknav strong").innerText(),
    "| показов:", await page.locator(".slot").count());
await page.screenshot({ path: `${SHOT}/calendar-past.png`, fullPage: true });

await page.locator('.weeknav a:text("Эта неделя")').click();
await page.waitForLoadState("networkidle");
log("вернулись:", await page.locator(".weeknav strong").innerText());
log("сегодня выделено:", await page.locator(".cal-head.today").count() === 1 ? "да" : "нет");

await browser.close();
log("проход завершён");
