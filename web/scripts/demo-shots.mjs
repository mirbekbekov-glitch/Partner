// Снимки демонстрации: публичный каталог, карточка объекта, отчёт
// собственнику и кабинет агента.
//
//   node scripts/demo-shots.mjs
//
// Нужен поднятый сервер и засеянная база разработки. Снимки кладутся в
// SHOT_DIR, по умолчанию /tmp/partner-shots.
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

async function shot(name, note) {
  await page.screenshot({ path: `${SHOT}/demo-${name}.png`, fullPage: true });
  log(`demo-${name}.png — ${note}`);
}

async function login(email) {
  await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
  const ask = page.locator("section.card").first();
  await ask.locator('input[name="address"]').fill(email);
  await ask.locator("button").click();
  await page.waitForSelector(".act-ok, .act-err");
  const notice = await page.locator(".act-ok, .act-err").first().innerText();
  const code = notice.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`код не выдан: ${notice}`);
  const enter = page.locator("section.card").nth(1);
  await enter.locator('input[name="address"]').fill(email);
  await enter.locator('input[name="code"]').fill(code);
  await enter.locator("button").click();
  await page.waitForURL("**/cabinet");
}

// --- публичная часть ---------------------------------------------------------
await page.goto(BASE, { waitUntil: "networkidle" });
log("каталог:", (await page.locator(".count, .result-count, main p").first().innerText().catch(() => "")).replace(/\n/g, " ").slice(0, 60));
await shot("catalog", "каталог: только объекты с действующим договором");

const first = page.locator('a[href^="/object/"]').first();
const href = await first.getAttribute("href");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
log("объект:", await page.locator("h1").first().innerText().catch(() => "—"));
await shot("object", "карточка объекта");

const token = process.env.REPORT_TOKEN;
if (token) {
  await page.goto(`${BASE}/report/${token}`, { waitUntil: "networkidle" });
  log("отчёт:", await page.locator("h1").first().innerText().catch(() => "—"));
  await shot("report", "отчёт собственнику по ссылке");
}

// --- кабинет -----------------------------------------------------------------
await login("bakyt@partner.kg");
log("вошли в кабинет");
await shot("cabinet", "главная кабинета: что требует внимания");

for (const [path, name, note] of [
  ["/cabinet/objects", "objects", "объекты агентства"],
  ["/cabinet/showings", "showings", "показы: день агента"],
  ["/cabinet/showings/week", "week", "календарь показов"],
  ["/cabinet/deals", "deals", "сделки и этапы"],
  ["/cabinet/notifications", "notifications", "уведомления"],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await shot(name, note);
}

// --- телефон -----------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE, { waitUntil: "networkidle" });
await shot("catalog-phone", "каталог на телефоне");
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
await shot("showings-phone", "показы на телефоне");

await browser.close();
log("готово");
