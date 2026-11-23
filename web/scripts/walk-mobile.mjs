// Проход по всем экранам в ширину телефона.
//
//   node scripts/walk-mobile.mjs
//   SHOT_DIR=/tmp/mob WALK_BASE=http://127.0.0.1:3001 node scripts/walk-mobile.mjs
//
// ЗАЧЕМ ОТДЕЛЬНО. Все остальные обходы ходят в ширину 1280 и больше. В стилях
// при этом девять правил для узких экранов — их не видел ни один обход. А
// агент работает с телефона: на показе, в машине, у подъезда. Экран, который
// там разъезжается, — это не косметика, это несделанная работа.
//
// ЧТО ПРОВЕРЯЕТСЯ АВТОМАТИЧЕСКИ. Горизонтальный вылет: страница шире экрана.
// Это единственный признак поломки вёрстки, который виден машине без спора о
// вкусе, — и он же самый частый: широкая таблица, длинный адрес без
// переносов, строка кнопок, картинка с заданной шириной.
//
// ВЫЛЕТ — НЕ ВСЯКИЙ ВЫХОД ЗА КРАЙ. Первая редакция ругалась на всё, что
// заходит за правую границу экрана, и выдала три ложные тревоги подряд:
// доска воронки, доска объектов в работе, календарь недели. Все три
// прокручиваются ВНУТРИ СЕБЯ — так и задумано, и в стилях про это написано
// прямым текстом: семь дней недели в ширину телефона не влезают, а неделя без
// субботы — не неделя. Страница при этом ровно 390, и ничего не разъезжается.
//
// Поэтому виноват только тот, кто вылез за край и НЕ ИМЕЕТ прокручиваемого
// предка. Предок с overflow-x: hidden виной не считается, а считается хуже:
// обрезанное там не достать ни прокруткой, ни как-либо ещё.
//
// Остальное смотрится глазами по снимкам: отсюда видно, что вёрстка не
// разъехалась, но не видно, читается ли она.

import { readFileSync, mkdirSync } from "node:fs";
import pg from "pg";

const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-mobile";
const WIDTH = Number(process.env.WALK_WIDTH ?? 390);   // iPhone 12/13/14
const HEIGHT = Number(process.env.WALK_HEIGHT ?? 844);

mkdirSync(SHOT, { recursive: true });

// --- адреса, которые без базы не собрать -------------------------------------
const dbUrl = readFileSync(new URL("../.env", import.meta.url), "utf8")
  .match(/^DATABASE_URL=(.*)$/m)?.[1];
if (!dbUrl) throw new Error("DATABASE_URL не найден в web/.env");
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const one = async (sql) => (await db.query(sql)).rows[0] ?? {};
const ids = {
  object: (await one("select id from objects where publication_state='published' order by created_at limit 1")).id,
  requirement: (await one("select id from requirements order by created_at limit 1")).id,
  deal: (await one("select id from deals order by created_at desc limit 1")).id,
  selection: (await one("select token from selections where sent_at is not null order by sent_at desc limit 1")).token,
  // Два вида ссылок лежат в одной таблице и различаются одним полем: со
  // ссылкой на объект это отчёт по объекту, без неё — кабинет собственника
  // целиком. Первая редакция брала первую попавшуюся строку и получала 404 на
  // кабинете, потому что подсунула ему токен отчёта.
  owner: (await one("select token from owner_access where object_id is null order by created_at limit 1")).token,
  report: (await one("select token from owner_access where object_id is not null order by created_at limit 1")).token,
};
await db.end();

const routes = [
  ["витрина", "/"],
  ["карточка объекта", `/object/${ids.object}`],
  ["подборка клиенту", ids.selection && `/selection/${ids.selection}`],
  ["кабинет собственника", ids.owner && `/owner/${ids.owner}`],
  ["отчёт по объекту", ids.report && `/report/${ids.report}`],
  ["вход", "/cabinet/login"],
  ["сводка", "/cabinet"],
  ["обращения", "/cabinet/inquiries"],
  ["клиенты", "/cabinet/requirements"],
  ["клиент", ids.requirement && `/cabinet/requirements/${ids.requirement}`],
  ["правка клиента", ids.requirement && `/cabinet/requirements/${ids.requirement}/edit`],
  ["новый клиент", "/cabinet/requirements/new"],
  ["воронка", "/cabinet/funnel"],
  ["задачи", "/cabinet/tasks"],
  ["показы", "/cabinet/showings"],
  ["неделя показов", "/cabinet/showings/week"],
  ["сделки", "/cabinet/deals"],
  ["сделка", ids.deal && `/cabinet/deals/${ids.deal}`],
  ["объекты в работе", "/cabinet/listings"],
  ["объекты", "/cabinet/objects"],
  ["объект", ids.object && `/cabinet/objects/${ids.object}`],
  ["правка объекта", ids.object && `/cabinet/objects/${ids.object}/edit`],
  ["новый объект", "/cabinet/objects/new"],
  ["подборки", "/cabinet/selections"],
  ["объявления", "/cabinet/candidates"],
  ["площадки", "/cabinet/channels"],
  ["уведомления", "/cabinet/notifications"],
  ["агенты", "/cabinet/agents"],
  ["расписание", "/cabinet/scheduler"],
  ["профиль", "/cabinet/profile"],
].filter(([, url]) => url);

// --- проход -------------------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
page.on("dialog", (d) => d.accept());

await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
const ask = page.locator("section.card").first();
await ask.locator('input[name="address"]').fill("aibek@partner.kg");
await ask.locator("button").click();
await page.waitForSelector(".act-ok, .act-err");
const notice = await page.locator(".act-ok, .act-err").first().innerText();
const code = notice.match(/\b(\d{6})\b/)?.[1];
if (!code) {
  throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
}
const enter = page.locator("section.card").nth(1);
await enter.locator('input[name="address"]').fill("aibek@partner.kg");
await enter.locator('input[name="code"]').fill(code);
await enter.locator("button").click();
await page.waitForURL("**/cabinet");

const findOverflow = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;

  // Ближайший предок, который умеет прокручиваться вбок. Если такой есть —
  // содержимое достижимо, и это не поломка, а длинная доска.
  const scroller = (el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === "auto" || ox === "scroll") return "прокрутка";
      if (ox === "hidden") {
        // Обрезано только то, что торчит за границу САМОГО обрезающего
        // предка. Иначе ругань достаётся не тому: календарь недели прячет
        // overflow ради скруглённых углов, дни лежат внутри его рамки, а
        // прокручивается рамка снаружи. Первая редакция объявляла поломкой
        // ровно это. Предок, который сам торчит, будет разобран отдельно —
        // в список попадают только самые внешние виновники.
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 1 || r.left < ar.left - 1) return "обрезано";
      }
    }
    return null;
  };

  const guilty = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (getComputedStyle(el).position === "fixed") continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const how = scroller(el);
    if (how === "прокрутка") continue;          // доска, календарь — так задумано
    guilty.push({ el, clipped: how === "обрезано" });
  }

  // Только самые внешние: у вложенных вина родителя.
  const outer = guilty.filter((g) => !guilty.some((o) => o.el !== g.el && o.el.contains(g.el)));
  return {
    page_width: document.documentElement.scrollWidth,
    viewport: vw,
    guilty: outer.slice(0, 4).map(({ el, clipped }) => {
      const r = el.getBoundingClientRect();
      return {
        what: el.tagName.toLowerCase()
          + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : ""),
        left: Math.round(r.left),
        right: Math.round(r.right),
        clipped,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48),
      };
    }),
  };
});

let broken = 0;
for (const [name, url] of routes) {
  const res = await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  const status = res?.status() ?? 0;
  const o = await findOverflow();
  const wide = o.page_width > o.viewport + 1;
  const ok = status === 200 && !wide && o.guilty.length === 0;
  if (!ok) broken += 1;
  console.log(`  ${ok ? "ok  " : "ПЛОХО"} ${name.padEnd(22)} ${status}` +
              (wide ? `  страница ${o.page_width}px при экране ${o.viewport}px` : ""));
  for (const g of o.guilty) {
    console.log(`         ${g.clipped ? "обрезано" : "торчит  "}: ${g.what}  [${g.left}..${g.right}]  «${g.text}»`);
  }
  await page.screenshot({
    path: `${SHOT}/${String(routes.indexOf(routes.find(([n]) => n === name)) + 1).padStart(2, "0")}-${name.replace(/\s+/g, "-")}.png`,
    fullPage: true,
  });
}

await browser.close();
console.log(broken === 0
  ? `\nв ширину ${WIDTH}px ничего не разъезжается; снимки: ${SHOT}\nпроход завершён`
  : `\nРАЗЪЕЗЖАЕТСЯ экранов: ${broken}; снимки: ${SHOT}`);
process.exit(broken === 0 ? 0 : 1);
