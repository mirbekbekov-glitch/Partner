// Проход по кабинету настоящим браузером: вход кодом, работа агента,
// решения администратора.
//
// Это НЕ тест: он ничего не утверждает и в tests/run.sh не входит. Он
// проходит кабинет насквозь и делает снимки, чтобы экраны можно было
// посмотреть глазами — включая те, которые иначе видишь только пустыми.
// Половина правок в кабинете родилась отсюда: неотформатированные телефоны,
// пять раскрытых форм отказа подряд, исчезающее сообщение об успехе.
//
// Нужен запущенный dev-сервер и данные: tests/seed.sql, db/dev_seed.sql,
// db/dev_seed_cabinet.sql.
//
//   node scripts/walk-cabinet.mjs
// Playwright берётся из окружения: статический import не принимает
// вычисляемый путь, поэтому загрузка динамическая.
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
const BASE = "http://localhost:3000";
const browser = await chromium.launch();
const log = (...a) => console.log(...a);

async function login(page, phone) {
  await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
  const ask = page.locator("section.card").first();
  await ask.locator('input[name="phone"]').fill(phone);
  await ask.locator("button").click();
  await page.waitForSelector(".act-ok, .act-err", { timeout: 15000 });
  const notice = await page.locator(".act-ok, .act-err").first().innerText();
  const code = notice.match(/\b(\d{6})\b/)?.[1];
  if (!code) {
    // Чаще всего это ограничение частоты: пять кодов в час на номер
    // (инвариант 18). Для прохода оно мешает, в бою — защищает владельца
    // номера от спама и нас от счёта за сообщения.
    throw new Error(
      `код не выдан: ${notice}\n` +
        "Если это ограничение частоты, в разработке его снимает\n" +
        "  psql -d partner -c 'delete from login_codes'",
    );
  }

  const enter = page.locator("section.card").nth(1);
  await enter.locator('input[name="phone"]').fill(phone);
  await enter.locator('input[name="code"]').fill(code);
  await enter.locator("button").click();
  await page.waitForURL("**/cabinet", { timeout: 15000 });
  return code;
}

// Подтверждения window.confirm Playwright по умолчанию отклоняет, поэтому
// действия с подтверждением без этого просто не происходили.
function acceptDialogs(page) {
  page.on("dialog", (d) => d.accept());
}

async function act(page, buttonText, scope) {
  const target = (scope ?? page).locator(`form:has(button:text("${buttonText}")) button`).first();
  await target.click();
  await page.waitForSelector(".act-ok, .act-err", { timeout: 20000 });
  return (await page.locator(".act-ok, .act-err").first().innerText()).replace(/\n/g, " ");
}

// =========================================================================
// Агент
// =========================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  acceptDialogs(page);

  await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-login.png`, fullPage: true });

  const code = await login(page, "0700 000 001");
  log(`агент Айбек вошёл кодом ${code}`);
  await page.screenshot({ path: `${SHOT}/cab-home.png`, fullPage: true });
  log("главная:", (await page.locator(".tile").allInnerTexts())
    .map((t) => t.split("\n").slice(0, 2).join(" ")).join(" | "));

  await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-objects.png`, fullPage: true });
  const own = await page.locator('.row:has(button:text("Подтвердить актуальность"))').count();
  log(`объектов всего ${await page.locator(".row").count()}, своих (с действиями) ${own}`);

  const row = page.locator('.row:has(button:text("Подтвердить актуальность"))').first();
  const addr = await row.locator("h3").innerText();
  log(`«${addr}» → ${await act(page, "Подтвердить актуальность", row)}`);

  const href = await row.locator("h3 a").first().getAttribute("href");
  await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-object.png`, fullPage: true });
  log("карточка:", await page.locator("h1").innerText(),
      "| фото:", await page.locator(".thumbs img").count(),
      "| собственник:", (await page.locator("section:has(h2:text('Собственник')) h3").count()) > 0);

  // Ссылка собственнику — то, чего нет ни у одной системы на рынке.
  if (await page.locator('button:text("Выдать ссылку")').count()) {
    log("ссылка собственнику →", await act(page, "Выдать ссылку"));
  }

  for (const [path, name] of [
    ["/cabinet/inquiries", "cab-inquiries"],
    ["/cabinet/candidates", "cab-candidates"],
    ["/cabinet/profile", "cab-profile"],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOT}/${name}.png`, fullPage: true });
    log(`${path}: «${await page.locator("h1").innerText()}», строк ${await page.locator(".row").count()}`);
  }

  // Админские разделы агенту не показываются и не открываются.
  const hasAdminNav = await page.locator('.cab-nav a[href="/cabinet/agents"]').count();
  await page.goto(`${BASE}/cabinet/agents`, { waitUntil: "networkidle" });
  const adminActions = await page.locator('button:text("Одобрить")').count();
  log(`агенту: ссылка «Агенты» в меню ${hasAdminNav}, кнопок одобрения на странице ${adminActions}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-mobile.png`, fullPage: true });
  log("вылет по горизонтали на 390px:",
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "px");

  await page.close();
}

// =========================================================================
// Администратор
// =========================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  acceptDialogs(page);
  await login(page, "0700 000 000");
  log("администратор вошёл");

  await page.goto(`${BASE}/cabinet/agents`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-agents.png`, fullPage: true });
  const pending = page.locator(".row:has(.chip.pending)").first();
  if (await pending.count()) {
    const who = await pending.locator("h3").innerText();
    // Успех приходит уведомлением сверху: кнопка исчезает вместе с формой.
    await pending.locator('form:has(button:text("Одобрить")) button').click();
    await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
    log(`одобрение «${who}» →`, await page.locator(".ok-banner, .act-err").first().innerText());
  } else {
    log("ожидающих одобрения нет");
  }

  // Последнего администратора разжаловать нельзя — и это должно быть видно
  // человеку словами, а не пустым экраном.
  const self = page.locator(".row:has(.chip.admin)").first();
  log("попытка разжаловать единственного админа →", await act(page, "Сделать агентом", self));
  await page.screenshot({ path: `${SHOT}/cab-agents-refusal.png`, fullPage: true });

  await page.goto(`${BASE}/cabinet/scheduler`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-scheduler.png`, fullPage: true });
  log("расписание →", await act(page, "Запустить все работы"));
  await page.goto(`${BASE}/cabinet/scheduler`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT}/cab-scheduler-after.png`, fullPage: true });
  log("после запуска:", (await page.locator(".row .chip").allInnerTexts()).join(", "));

  await page.close();
}

await browser.close();
log("проход завершён");
