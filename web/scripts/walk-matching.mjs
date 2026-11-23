// Проход по подбору: клиент из обращения, подбор под его условия,
// предложение объекта, назначение и закрытие показа.
//
//   node scripts/walk-matching.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;

import { readFileSync } from "node:fs";
import pg from "pg";

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

// --- вход ------------------------------------------------------------------
await page.goto(`${BASE}/cabinet/login`, { waitUntil: "networkidle" });
const ask = page.locator("section.card").first();
await ask.locator('input[name="address"]').fill("aibek@partner.kg");
await ask.locator("button").click();
await page.waitForSelector(".act-ok, .act-err");
const notice = await page.locator(".act-ok, .act-err").first().innerText();
const code = notice.match(/\b(\d{6})\b/)?.[1];
if (!code) throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
const enter = page.locator("section.card").nth(1);
await enter.locator('input[name="address"]').fill("aibek@partner.kg");
await enter.locator('input[name="code"]').fill(code);
await enter.locator("button").click();
await page.waitForURL("**/cabinet");
log("агент вошёл");

// --- своё обращение ---------------------------------------------------------
// Обход заводит обращение СЕБЕ, а не берёт то, что лежит в данных разработки.
//
// Каждый прогон превращал одно обращение в клиента, пул кончался, и обход
// падал на пустом списке — выглядело это как поломка продукта, а было
// поломкой проверки: она зависела от запаса, который наполняет кто-то другой.
// Со своим обращением прогон самодостаточен и не зависит от порядка обходов.
//
// Это подготовка данных владельцем базы, как в scripts/make-dev-photos.mjs, а
// не путь приложения: формы обращения на витрине пока нет — обращения
// приносит сборщик, и register_inquiry выдана роли authenticated.
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const dbUrl = envText.match(/^DATABASE_URL=(.*)$/m)?.[1];
if (!dbUrl) throw new Error("DATABASE_URL не найден в web/.env: обходу негде завести обращение");

const mark = `Обход ${String(Date.now()).slice(-6)}`;
{
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const { rows } = await db.query(
    "select auth_user_id from agents where email = $1", ["aibek@partner.kg"]);
  if (!rows[0]?.auth_user_id) throw new Error("агент aibek@partner.kg не найден в базе");
  await db.query("set role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: rows[0].auth_user_id, role: "authenticated" })]);
  await db.query(
    "select register_inquiry('site','demand','обход',$1,'0700 000 111',$2,null)",
    [mark, "двушка в центре до 90 тысяч"]);
  await db.end();
  log("обращение для прогона заведено:", mark);
}

// --- клиент из обращения ----------------------------------------------------
await page.goto(`${BASE}/cabinet/inquiries`, { waitUntil: "networkidle" });
const fromInquiry = page
  .locator(`.row:has(a:text("Завести клиента")):has-text(${JSON.stringify(mark)})`)
  .first();
if ((await fromInquiry.count()) === 0) {
  throw new Error(`обращение «${mark}» заведено, но в кабинете его нет`);
}
const who = await fromInquiry.locator("h3").innerText();
await fromInquiry.locator('a:text("Завести клиента")').click();
await page.waitForURL("**/requirements/new?inquiry=*", { timeout: 20000 });
log(`форма клиента из обращения «${who.split("\n")[0]}»:`,
    "имя", JSON.stringify(await page.locator('input[name="client_name"]').inputValue()),
    "| телефон", await page.locator('input[name="client_phone"]').inputValue());
await page.screenshot({ path: `${SHOT}/requirement-new.png`, fullPage: true });

// Имя в обращении может отсутствовать — агент выясняет его разговором.
if ((await page.locator('input[name="client_name"]').inputValue()) === "") {
  await page.locator('input[name="client_name"]').fill("Клиент из обращения");
}
await page.locator('select[name="deal_type"]').selectOption("sale");
await page.locator('input[name="budget_min"]').fill("50000");
await page.locator('input[name="budget_max"]').fill("90000");
await page.locator('input[name="zones"]').fill("Центр, Юг");
await page.locator('input[name="rooms"]').fill("1, 2");
await page.locator('button:text("Завести клиента")').click();
await page.waitForURL(/\/cabinet\/requirements\/[0-9a-f-]{36}/, { timeout: 30000 });
const requirementUrl = page.url().split("?")[0];
log("создано →", await page.locator(".ok-banner").first().innerText());

// --- подбор -----------------------------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/matching.png`, fullPage: true });
const fits = await page.locator('h2:text("Подходит")').innerText();
const nearly = (await page.locator('h2:text("Чуть дороже")').count())
  ? await page.locator('h2:text("Чуть дороже")').innerText() : "нет";
log("подбор:", fits.replace(/\n/g, " "), "| чуть дороже:", nearly.replace(/\n/g, " "));

const first = page.locator('.row:has(button:text("Предложить клиенту"))').first();
if ((await first.count()) === 0) throw new Error("подбор ничего не нашёл — проверьте данные");
const offered = await first.locator("h3").innerText();
await first.locator('form:has(button:text("Предложить клиенту")) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log(`предложено «${offered}» →`, await page.locator(".ok-banner, .act-err").first().innerText());

// --- показ -------------------------------------------------------------------
await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.locator('summary:text("Назначить показ")').first().click();
// Завтра в 10:30, а не «через сутки». «Через сутки» — это тот же час, что
// сейчас, и ночью проход падал на отказе базы «показы назначают с 08:00 до
// 21:00»: инвариант работал, а проход зависел от часов на машине. Ошибка
// выглядела как поломка продукта и была поломкой проверки.
// Время СВОЁ у каждого прогона и всегда внутри рабочего окна 08:00–21:00.
//
// Фиксированное «завтра в 10:30» ломалось дважды подряд, и каждый раз это
// выглядело как поломка продукта. Сначала было «через сутки» — то есть тот же
// час, что сейчас, и ночью база отказывала: показы назначают с 08:00 до
// 21:00. Потом стало 10:30 — и следующий прогон упирался в показ,
// оставленный предыдущим: «в это время у агента уже показ».
//
// Отмена показа в конце прогона есть и убирает след. Но прогон, упавший
// посередине, убрать за собой не успеет, а обход не должен зависеть от того,
// что прошлый раз закончился хорошо.
const pad = (n) => String(n).padStart(2, "0");
const now = Date.now();
//
// Час в строке формы — это БИШКЕКСКИЙ час: приложение читает поле как местное
// время, а не как UTC, и окно 08:00–21:00 проверяет по нему же. Попытка
// пересчитать часы в UTC давала «показы назначают с 08:00 до 21:00, а это
// 06:30» — обход переводил время дважды.
const day = new Date(now + 86400000 * (1 + (now % 5)));
const hour = 9 + (Math.floor(now / 1000) % 9);        // 09..17 по Бишкеку
const minute = (Math.floor(now / 100) % 12) * 5;
const when = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  + `T${pad(hour)}:${pad(minute)}`;
await page.locator('input[name="at"]').first().fill(when);
await page.locator('form:has(input[name="at"]) button').first().click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
const scheduled = await page.locator(".ok-banner, .act-err").first().innerText();
if (!/назначен/i.test(scheduled)) throw new Error(`показ не назначен: ${scheduled}`);
log("показ →", scheduled);

await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/matching-showing.png`, fullPage: true });

// Закрыть показ, который ещё не наступил, нельзя — и проверяется здесь
// именно отказ. Исход показа это не предсказание, а запись о том, что было.
//
// Закрытие НАСТОЯЩЕГО, прошедшего показа проверяет scripts/walk-showings.mjs:
// там для этого есть забытый показ из прошлого. Здесь его взять неоткуда —
// назначать задним числом база не даёт, и правильно делает.
await page.locator('summary:text("Показ прошёл")').first().click();
await page.locator('select[name="outcome"]').first().selectOption("interested");
await page.locator('input[name="reaction"]').first().fill("Понравился вид из окна");
await page.locator('form:has(select[name="outcome"]) button').first().click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
const closing = await page.locator(".ok-banner, .act-err").first().innerText();
if (!/не наступил/.test(closing)) {
  throw new Error(`будущий показ закрылся исходом: ${closing}`);
}
log("закрытие будущего показа отклонено →", closing);

// Показ ОТМЕНЯЕТСЯ в конце, и это не вежливость.
//
// Время назначения фиксированное — завтра в 10:30, внутри рабочего окна. Без
// отмены следующий прогон упирался в показ, оставленный предыдущим: «в это
// время у агента уже показ 24.11 в 10:30». Обход падал от собственного следа,
// и выглядело это как поломка продукта. Заодно проверяется сама отмена.
await page.goto(requirementUrl, { waitUntil: "networkidle" });
await page.locator('summary:text("Отменить показ")').first().click();
// Причина обязательна: без неё браузер не отпустит форму, и отмена не
// произойдёт вовсе — молча, без единой ошибки на экране.
await page
  .locator('details:has(summary:text("Отменить показ")) input[name="reason"]')
  .first()
  .fill("уборка за прогоном обхода");
await Promise.all([
  page.waitForResponse((r) => r.request().method() === "POST" && r.status() < 400),
  page.locator('details:has(summary:text("Отменить показ")) button').first().click(),
]);
await page.goto(requirementUrl, { waitUntil: "networkidle" });
if ((await page.locator('summary:text("Показ прошёл")').count()) !== 0) {
  throw new Error("показ не отменился: его всё ещё предлагают закрыть исходом");
}
log("показ отменён: время снова свободно");

await page.goto(requirementUrl, { waitUntil: "networkidle" });
log("состояния подбора:", (await page.locator(".chip").allInnerTexts()).join(" | "));
await page.screenshot({ path: `${SHOT}/matching-after.png`, fullPage: true });

// --- чужой клиент -------------------------------------------------------------
await page.goto(`${BASE}/cabinet/requirements`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOT}/requirements.png`, fullPage: true });
log("клиентов в списке:", await page.locator(".row").count(),
    "| кнопок «Подбор»:", await page.locator('a:text("Подбор")').count());

await browser.close();
log("проход завершён");
