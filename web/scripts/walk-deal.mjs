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

// Действие и ожидание ЕГО ОТВЕТА.
//
// Ждать баннера нельзя: на этих страницах баннер от предыдущего действия уже
// висит, waitForSelector(".ok-banner") возвращается мгновенно, и обход бежит
// дальше по странице, которой ещё нет. Так закрытие сделки «проходило», не
// происходя: суммы до и после совпадали, кнопка закрытия оставалась на
// месте, а обход печатал зелёные строки.
async function submit(button) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
    button.click(),
  ]);
}

// --- свой клиент с подбором --------------------------------------------------
// Обход заводит клиента СЕБЕ, а не берёт первую подходящую строку из списка.
//
// Закрытая сделка закрывает и потребность, и мандат, поэтому каждый прогон
// съедал один набор данных из засева. А когда первой в списке оказалась
// потребность с пустым подбором, обход упал с «подбор пуст — проверьте
// данные»: выглядело как поломка продукта, было зависимостью проверки от
// того, что лежит в базе и в каком порядке.
//
// Условия те же, под которыми scripts/walk-matching.mjs получает пять
// вариантов: если подбор окажется пуст теперь — сломан подбор, а не данные.
const stamp = String(Date.now()).slice(-6);
const mark = `Сделка ${stamp}`;
// Телефон тоже свой: клиент ищется ПО ТЕЛЕФОНУ, и с общим номером каждый
// прогон цеплялся к контакту первого — в сделке стояло чужое имя, а обход
// печатал своё. Один телефон — один человек, это правильно; значит и номер
// у прогона должен быть свой.
const phone = `0700 ${stamp}`;
await page.goto(`${BASE}/cabinet/requirements/new`, { waitUntil: "networkidle" });
await page.locator('input[name="client_name"]').fill(mark);
await page.locator('input[name="client_phone"]').fill(phone);
await page.locator('select[name="deal_type"]').selectOption("sale");
await page.locator('input[name="budget_min"]').fill("50000");
await page.locator('input[name="budget_max"]').fill("90000");
await page.locator('input[name="zones"]').fill("Центр, Юг");
await page.locator('input[name="rooms"]').fill("1, 2");
await page.locator('button:text("Завести клиента")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 30000 });
const requirementUrl = page.url().split("?")[0];
log("клиент для прогона заведён:", mark);

// Если клиенту ещё ничего не предложено — предлагаем.
if ((await page.locator('button:text("Завести сделку")').count()) === 0) {
  const first = page.locator('.row:has(button:text("Предложить клиенту"))').first();
  if ((await first.count()) === 0) {
    throw new Error("подбор пуст под теми же условиями, под которыми walk-matching находит пять: сломан подбор");
  }
  // Ждём ОТВЕТА действия, а не баннера.
  //
  // Баннер «Потребность заведена» уже висел на экране с прошлого шага, и
  // waitForSelector(".ok-banner") возвращался мгновенно — страница
  // перечитывалась раньше, чем действие успевало отработать, и кнопки
  // «Завести сделку» в перечитанном ответе ещё не было. Дальше обход ждал её
  // тридцать секунд на статической странице, где она сама не появится.
  // Падало через раз и выглядело как поломка продукта.
  await submit(first.locator('form:has(button:text("Предложить клиенту")) button'));
  await page.goto(requirementUrl, { waitUntil: "networkidle" });
}

// --- заводим сделку ----------------------------------------------------------
await page.locator('form:has(button:text("Завести сделку")) button').first().click();
await page.waitForURL(/\/cabinet\/deals\/[0-9a-f-]{36}/, { timeout: 30000 });
const dealUrl = page.url().split("?")[0];
log("сделка заведена →", await page.locator(".ok-banner").first().innerText());
await page.screenshot({ path: `${SHOT}/deal-open.png`, fullPage: true });

const beforeMoney = (await page.locator(".facts").allInnerTexts()).join(" | ").replace(/\n/g, " ");
log("деньги до закрытия:", beforeMoney.slice(0, 190));

// --- закрываем ----------------------------------------------------------------
await page.locator('input[name="final_price"]').fill("95000");
await submit(page.locator('form:has(input[name="final_price"]) button'));

await page.goto(dealUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/deal-closed.png`, fullPage: true });

// Закрытие проверяется тремя признаками, а не печатается строкой. Печаталось
// оно и тогда, когда сделка не закрывалась вовсе.
if ((await page.locator('button:text("Закрыть сделку")').count()) !== 0) {
  throw new Error("сделка не закрылась: кнопка закрытия на месте");
}
const afterMoney = (await page.locator(".facts").allInnerTexts()).join(" | ").replace(/\n/g, " ");
if (afterMoney === beforeMoney) {
  throw new Error("суммы после закрытия те же: они так и остались индикативными");
}
if (!/зафиксирован/i.test(await page.locator("main").innerText())) {
  throw new Error("на закрытой сделке не сказано, что суммы зафиксированы");
}
log("состояние:", (await page.locator(".chip").allInnerTexts()).join(" | "));
log("деньги после закрытия:", afterMoney.slice(0, 190));

// --- что стало с объектом и клиентом -------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
log("состояния подбора после сделки:",
    (await page.locator(".chip").allInnerTexts()).join(" | "));

// --- чужая сделка ---------------------------------------------------------------
await page.goto(`${BASE}/cabinet/deals`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/deals.png`, fullPage: true });
log("сделок в списке:", await page.locator(".row").count(),
    "| кнопок «Открыть»:", await page.locator('a:text("Открыть")').count());

// Чынгыз — коллега из ТОГО ЖЕ агентства, но в этой сделке не участвует.
// Инвариант 33: «чужую сделку, в которой не участвуешь, не видно» — и не
// видно вовсе, а не «видно с оговоркой».
//
// Прежняя редакция ждала здесь заголовок сделки и предупреждение рядом с
// ним. Она была написана, когда сделку показывали чужому с оговоркой; теперь
// её не показывают. Проверка осталась от прежнего поведения и падала на
// отсутствующем h1 — то есть ловила не дефект, а собственную устарелость.
await login("chyngyz@partner.kg");
const foreign = await page.goto(dealUrl, { waitUntil: "networkidle" });
if (foreign?.status() !== 404) {
  throw new Error(`коллега не из сделки получил ${foreign?.status()}, а сделки видеть не должен`);
}
if ((await page.locator('button:text("Закрыть сделку")').count()) !== 0) {
  throw new Error("коллеге не из сделки предложено её закрыть");
}
log("коллега не из сделки: сделки не видит (404), закрыть не предложено");

await browser.close();
log("проход завершён");
