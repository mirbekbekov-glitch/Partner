// Проход по экрану показов: день агента, просроченный показ, четыре исхода.
//
//   node scripts/walk-showings.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

import { readFileSync } from "node:fs";
import pg from "pg";

// --- фикстура: показы, на которых держится этот обход -----------------------
//
// Обход закрывает просроченный показ исходом, помечает неявку и переносит
// встречу — то есть съедает за прогон один забытый показ и два назначенных.
// Из db/dev_seed_cabinet.sql их ровно столько, сколько хватает на один раз:
// после первого прогона обход падал, не найдя ни строки. Падение выглядело
// как поломка продукта.
//
// Поэтому фикстуру готовит тот, кому она нужна, и готовит заново на каждом
// прогоне. Назначить показ задним числом приложение не даёт, и правильно
// делает: показ — это уговор на будущее. Вставка идёт от владельца таблиц,
// тем же способом, что в засеве.
{
  const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const dbUrl = envText.match(/^DATABASE_URL=(.*)$/m)?.[1];
  if (!dbUrl) throw new Error("DATABASE_URL не найден в web/.env");
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();

  // Подбор берётся такой, у которого назначенного показа ещё нет: иначе
  // вторая вставка легла бы на тот же подбор, а база справедливо считает это
  // накладкой.
  const add = async (at) => {
    const { rowCount } = await db.query(`
      insert into showings (match_id, agent_id, scheduled_at, status, created_by_agent_id)
      select m.id, a.id, $1::timestamptz, 'scheduled', a.id
        from matches m
        join requirements r on r.id = m.requirement_id
        join agents a on a.email = 'bakyt@partner.kg'
       where r.agent_id = a.id
         and not exists (select 1 from showings s
                          where s.match_id = m.id and s.status = 'scheduled')
       order by m.created_at
       limit 1`, [at]);
    return rowCount;
  };

  // Фикстура ДОСОЗДАЁТ недостающее, а не добавляет каждый раз.
  //
  // Прогон, упавший посередине, оставляет назначенный показ за собой. Вторая
  // версия фикстуры всё равно вставляла свой — и упиралась в накладку: «в это
  // время у агента уже показ». База права, ошибка была в фикстуре.
  const count = async (when) => (await db.query(`
    select count(*)::int n from showings s
      join matches m on m.id = s.match_id
      join requirements r on r.id = m.requirement_id
      join agents a on a.id = r.agent_id
     where a.email = 'bakyt@partner.kg'
       and s.status = 'scheduled'
       and s.scheduled_at ${when} now()`)).rows[0].n;

  // Забытый: двадцать часов назад, а не двое суток. Инвариант 25 разрешает
  // назначать в прошлое не дальше app.showing_backdate_limit(), и это ровно
  // двое суток — первая версия фикстуры об него и споткнулась.
  if ((await count("<")) === 0) {
    const late = new Date(Date.now() - 20 * 3600 * 1000);
    if ((await add(late.toISOString())) === 0) {
      throw new Error("забытый показ не завёлся: у Бакыта нет подбора без назначенного показа");
    }
  }

  // Назначенные: на них проверяются неявка и перенос. Часы разные у каждого
  // прогона — иначе прогон упирался бы в показ, оставленный предыдущим.
  const stamp = Date.now();
  let ahead = await count(">");
  for (let k = 0; ahead < 3 && k < 6; k += 1) {
    const at = new Date(stamp + (3 + k) * 86400000);
    // Часы в UTC, а окно 08:00–21:00 база считает по Бишкеку (UTC+6). 3..12
    // по UTC — это 09:00–18:00 по Бишкеку. Первая версия ставила 9..19 по
    // UTC, то есть до часу ночи по Бишкеку, и база справедливо отказывала.
    at.setUTCHours(3 + ((Math.floor(stamp / 1000) + k) % 10), (Math.floor(stamp / 100) % 12) * 5, 0, 0);
    ahead += await add(at.toISOString());
  }
  await db.end();
  if (ahead < 2) {
    throw new Error(`назначенных показов у Бакыта ${ahead}: обходу нужно хотя бы два`);
  }
}

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
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

/** Раскрыть складку и нажать её кнопку. */
async function act(card, summary, fill) {
  await card.locator(`summary:text("${summary}")`).click();
  const form = card.locator(`details:has(summary:text("${summary}")) form`);
  if (fill) await fill(form);
  await form.locator("button").click();
  await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
  return (await page.locator(".ok-banner, .act-err").first().innerText()).replace(/\n/g, " ");
}

await login("bakyt@partner.kg");
log("агент вошёл");

// --- дашборд: плитка просроченных -------------------------------------------
const tiles = (await page.locator(".tile").allInnerTexts()).map((t) => t.replace(/\n/g, " "));
log("плитки про показы:", tiles.filter((t) => /показ/.test(t)).join(" | "));

// --- экран показов -----------------------------------------------------------
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
log("разделы:", (await page.locator("h2").allInnerTexts()).map((t) => t.replace(/\n/g, " ")).join(" / "));

const firstDay = page.locator("section", { has: page.locator("h2") }).nth(1);
log("просрочено:", await page.locator(".row.showing.late .showing-when").first().innerText().then((t) => t.replace(/\n/g, " ")),
    "|", await page.locator(".row.showing.late h3").first().innerText());
await page.screenshot({ path: `${SHOT}/showings-day.png`, fullPage: true });

// --- забытый показ закрывается ----------------------------------------------
const late = page.locator(".row.showing.late").first();
log("закрываю забытый показ →", await act(late, "Показ прошёл", async (form) => {
  await form.locator('select[name="outcome"]').selectOption("wants_bargain");
  await form.locator('input[name="reaction"]').fill("готов брать, просит скидку");
}));

await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
log("просроченных осталось:", await page.locator(".row.showing.late").count());

// --- неявка ------------------------------------------------------------------
const first = page.locator(".row.showing").first();
const where = await first.locator("h3").innerText();
log("неявка по", where, "→", await act(first, "Не пришёл", async (form) => {
  await form.locator('input[name="note"]').fill("не приехал, телефон молчит");
}));

// --- перенос -----------------------------------------------------------------
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
const next = page.locator(".row.showing").first();
const moved = await next.locator("h3").innerText();
const at = new Date(Date.now() + 5 * 86400000);
at.setUTCHours(10, 0, 0, 0);
const local = at.toISOString().slice(0, 16);
log("перенос", moved, "→", await act(next, "Перенести", async (form) => {
  await form.locator('input[name="at"]').fill(local);
}));

// --- два места одновременно: база не даёт ------------------------------------
// Берём время уже назначенного показа и переносим на него показ по ДРУГОМУ
// объекту: по инварианту 25 агент не бывает в двух местах одновременно.
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
const cards = page.locator(".row.showing");
if ((await cards.count()) >= 2) {
  const taken = await cards.first().locator("time").getAttribute("datetime");
  const victim = cards.nth(1);
  const where = await victim.locator("h3").innerText();
  log(`переношу «${where}» на ${taken} — время уже занято`);
  await victim.locator('summary:text("Перенести")').click();
  const form = victim.locator('details:has(summary:text("Перенести")) form');
  await form.locator('input[name="at"]').fill(taken);
  await form.locator("button").click();
  await page.waitForSelector(".act-err, .ok-banner", { timeout: 20000 });
  const said = (await page.locator(".act-err, .ok-banner").first().innerText()).replace(/\n/g, " ");
  log("база сказала:", said);
  await page.screenshot({ path: `${SHOT}/showings-clash.png`, fullPage: true });
}

// --- история -----------------------------------------------------------------
await page.goto(`${BASE}/cabinet/showings`, { waitUntil: "networkidle" });
const history = page.locator("section:has(h2:text(\"История\")) .row");
log("в истории:", await history.count(), "показов");
log("исходы:", (await page.locator("section:has(h2:text(\"История\")) .row-state").allInnerTexts())
      .map((t) => t.replace(/\n/g, " ")).slice(0, 4).join(" | "));
await page.screenshot({ path: `${SHOT}/showings-history.png`, fullPage: true });

await browser.close();
log("проход завершён");
