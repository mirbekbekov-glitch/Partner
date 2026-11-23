// Проход по бесплатному тарифу: что одиночка видит и чего не может.
//
//   node scripts/walk-plan.mjs
//
// ЗАЧЕМ ОТДЕЛЬНО. Все остальные обходы ходят Айбеком и Бакытом — они в
// Liberterra, у которой тариф «команда», и ограничений не видят вовсе. То
// есть экраны, написанные ради бесплатного тарифа, не проверял никто.
//
// Ходит Нурлан из «Альфы»: одно агентство, один человек, тариф solo.
//
// Проверяется ровно то, ради чего тариф затевался: объекты и клиенты не
// ограничены, чужие площадки закрыты, и об этом сказано ДО отказа, а не
// отказом. Ограничение, о котором узнаёшь только отказом, выглядит поломкой.

const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

const EMAIL = "nurlan@alfa.kg";
await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
const ask = page.locator("section.card").first();
await ask.locator('input[name="address"]').fill(EMAIL);
await ask.locator("button").click();
await page.waitForSelector(".act-ok, .act-err");
const notice = await page.locator(".act-ok, .act-err").first().innerText();
const code = notice.match(/\b(\d{6})\b/)?.[1];
if (!code) {
  throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
}
const enter = page.locator("section.card").nth(1);
await enter.locator('input[name="address"]').fill(EMAIL);
await enter.locator('input[name="code"]').fill(code);
await enter.locator("button").click();
await page.waitForURL("**/cabinet");
log("одиночка вошёл:", EMAIL);

// --- площадки -----------------------------------------------------------------
await page.goto(`${BASE}/cabinet/channels`, { waitUntil: "networkidle" });
const channelsText = await page.locator("main").innerText();
if (!/тариф.*команда|«команда»/i.test(channelsText)) {
  throw new Error("на экране площадок не сказано, что выгрузка — на платном тарифе");
}
log("площадки: ограничение названо до отказа");
await page.screenshot({ path: `${SHOT}/plan-channels.png`, fullPage: true });

// --- агенты -------------------------------------------------------------------
await page.goto(`${BASE}/cabinet/agents`, { waitUntil: "networkidle" });
const agentsText = await page.locator("main").innerText();
if (!/один агент/i.test(agentsText)) {
  throw new Error("на экране агентов не сказано, что на бесплатном тарифе один агент");
}
if (!/не ограничен/i.test(agentsText)) {
  throw new Error("не сказано, что объекты и клиенты не ограничены — а это главное в этом тарифе");
}
log("агенты: сказано и про одного, и про то, что база не ограничена");
await page.screenshot({ path: `${SHOT}/plan-agents.png`, fullPage: true });

// --- а работа не ограничена ----------------------------------------------------
// Главное решение тарифа проверяется действием, а не словами на экране:
// одиночка заводит объект, и ему никто не мешает.
await page.goto(`${BASE}/cabinet/objects/new`, { waitUntil: "networkidle" });
const stamp = String(Date.now()).slice(-6);
await page.locator('input[name="address"]').fill(`Альфина ${stamp}`);
await page.locator('input[name="price"]').fill("64000");
await page.locator('input[name="owner_name"]').fill(`Собственник ${stamp}`);
await page.locator('input[name="owner_phone"]').fill(`0700 ${stamp}`);
await page.locator('select[name="kind"]').selectOption("flat");
await page.locator('input[name="rooms"]').fill("2");
await page.locator('input[name="area"]').fill("54");
await page.locator('input[name="zone"]').fill("Центр");
await page.locator('input[name="contract_confirmed"]').check();
await page.locator('button:text("Завести объект")').click();
await page.waitForURL(/\/cabinet\/objects\/[0-9a-f-]{36}/, { timeout: 30000 });
log("объект заведён на бесплатном тарифе:", await page.locator("h1").innerText());

// --- а площадку включить нельзя, и отказ объясняет почему ----------------------
const objectText = await page.locator("main").innerText();
if (!/Лалафо|lalafo/i.test(objectText)) {
  log("на карточке объекта площадок нет — проверять отказ нечем");
} else {
  const toggle = page.locator('form:has(input[name="channel"][value="lalafo"]) button').first();
  if ((await toggle.count()) > 0) {
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST").catch(() => null),
      toggle.click(),
    ]);
    const said = await page.locator(".act-err").first().innerText().catch(() => "");
    if (!/команда/i.test(said)) {
      throw new Error(`включение чужой площадки не отклонено по тарифу: ${said || "(тишина)"}`);
    }
    log("включение Лалафо отклонено:", said.replace(/\n/g, " "));
  }
}

await browser.close();
log("проход завершён");
