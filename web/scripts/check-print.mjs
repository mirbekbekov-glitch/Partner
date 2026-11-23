// Проверка печатного листа подборки.
//
// ЗАЧЕМ ОТДЕЛЬНО. PDF у нас — это та же страница, напечатанная браузером, и
// держится он на правилах `@media print`. Такие правила ломаются молча:
// смотрят в веб, а клиенту уходит лист. Ни один обход браузера этого не
// увидит, потому что на экране всё по-прежнему хорошо.
//
// Проверяется четыре вещи, и каждая ломалась бы незаметно:
//
//   1. с листа убрано то, чего на нём быть не должно: шапка сайта, подвал и
//      сама кнопка «Сохранить PDF» — ссылку с бумаги не нажать;
//   2. вариант не разрезан между страницами. Половина квартиры на одном
//      листе и половина на другом — это не презентация;
//   3. фотографий в блоке не больше четырёх: дальше они мельчают до
//      бесполезности, а бумаги уходит вдвое, и платит за неё агент;
//   4. на листе есть агентство и дата. Документ, который клиент показывает
//      мужу, матери или банку, не должен быть ничьим, а подборка без даты
//      через месяц врёт с тем же уверенным видом: цены стареют.
//
// Каждая проверена мутацией: правило в @media print снимается по одному, и
// красной обязана стать ровно та строка, которая за него отвечает. Первые две
// версии проверки на разрыв мутацию пережили — обе были зелёными и
// бесполезными; что именно в них было не так, написано у самой проверки.
//
//   node scripts/check-print.mjs <токен подборки>
//
// Нужен поднятый стенд и pdftotext (poppler).

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import pw from "playwright";

const { chromium } = pw;
const token = process.argv[2];
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "/tmp/partner-shots";

if (!token) {
  console.error("нужен токен подборки: node scripts/check-print.mjs <токен>");
  process.exit(1);
}

let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? "ok  " : "ПЛОХО"} ${what}`);
  if (!cond) failed += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const res = await page.goto(`${BASE}/selection/${token}`, { waitUntil: "networkidle" });
ok(res?.status() === 200, `страница подборки открылась (${res?.status()})`);

const variants = await page.locator(".report-block").count();
ok(variants > 0, `вариантов на странице: ${variants}`);

// --- печатный носитель ------------------------------------------------------
await page.emulateMedia({ media: "print" });

const hidden = async (sel) =>
  (await page.locator(sel).count()) === 0 ||
  !(await page.locator(sel).first().isVisible().catch(() => true));

ok(await hidden(".site-head"), "шапки сайта на листе нет");
ok(await hidden(".site-foot"), "подвала на листе нет");
ok(await hidden(".print-bar"), "кнопки «Сохранить PDF» на листе нет");

// Фотографий на листе не больше четырёх в блоке. Дальше они мельчают до
// бесполезности, а бумаги уходит вдвое — у агента печать идёт из своего
// кармана. Правило легко снять, не заметив: на экране ничего не изменится.
const shots = await page
  .locator(".report-block")
  .evaluateAll((bs) =>
    bs.map(
      (b) =>
        [...b.querySelectorAll(".shots img")].filter(
          (i) => getComputedStyle(i).display !== "none",
        ).length,
    ),
  );
const most = Math.max(0, ...shots);
ok(most <= 4, `фотографий в блоке на листе не больше четырёх (самый полный: ${most})`);

// Из DOM берутся ЯКОРЯ, по которым потом режется текст листа: адрес каждого
// варианта и начало подписи под последним из них.
const addresses = await page
  .locator(".report-block h2")
  .evaluateAll((hs) => hs.map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim()));
const noteHead = (
  await page.locator(".report-note").first().textContent()
)
  ?.replace(/\s+/g, " ")
  .trim()
  .slice(0, 30);

const pdf = `${OUT}/selection-check.pdf`;
fs.mkdirSync(OUT, { recursive: true });
await page.pdf({
  path: pdf,
  format: "A4",
  printBackground: false,
  margin: { top: "1.4cm", bottom: "1.4cm", left: "1.4cm", right: "1.4cm" },
});
await browser.close();

// --- разбор листа -----------------------------------------------------------
function textOf(n) {
  try {
    return execFileSync("pdftotext", ["-f", String(n), "-l", String(n), "-layout", pdf, "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // за концом PDF pdftotext шумит в stderr
    });
  } catch {
    return "";
  }
}

const pages = [];
for (let n = 1; n <= 40; n += 1) {
  const t = textOf(n);
  if (!t.trim()) break;
  pages.push(t);
}
ok(pages.length > 0, `страниц в PDF: ${pages.length}`);

// РАЗРЫВ ВАРИАНТА.
//
// Две предыдущие версии этой проверки были зелёными и бесполезными, и обе
// разоблачила одна и та же мутация — снять `break-inside: avoid`.
//
//   Первая считала на каждой странице характеристики и цены и сравнивала
//   числа. Ловила разрыв, только если он приходился ровно между ними.
//
//   Вторая требовала, чтобы адрес и цена варианта лежали на одной странице.
//   Мутация показала, что разрыв ложится НИЖЕ цены: лист кончался ценой
//   «$280 в месяц», а описание того же варианта уезжало на следующий.
//
// Теперь проверяется весь блок целиком, а не две его точки. Текст листа
// склеивается в одну строку с запомненными границами страниц; вариант
// занимает отрезок от своего адреса до адреса следующего (последний — до
// подписи под списком), и весь отрезок обязан лежать на одной странице.
// Что бы ни оказалось внутри блока потом — описание, пометка клиента, новая
// строка, — оно под проверкой само собой, без правки этого кода.
//
// Предел, который честнее назвать, чем прятать: разрыв внутри полосы
// фотографий виден отсюда только если под ним есть текст. Полоса в самом
// низу блока из текста неразличима.
const norm = (t) => t.replace(/\s+/g, " ").trim();
const pageText = pages.map(norm);

const bounds = [];
let off = 0;
for (const t of pageText) {
  bounds.push([off, off + t.length]);
  off += t.length + 1; // пробел-разделитель между страницами
}
const joined = pageText.join(" ");
const pageOf = (i) => bounds.findIndex(([a, b]) => i >= a && i < b);

// Якоря ищутся по порядку, каждый следующий — после предыдущего: так
// одинаковые описания у разных вариантов не сбивают разметку.
let cur = 0;
const at = [];
for (const a of addresses) {
  const i = a ? joined.indexOf(a, cur) : -1;
  at.push(i);
  if (i >= 0) cur = i + a.length;
}
const noteAt = noteHead ? joined.indexOf(noteHead, cur) : -1;

ok(
  at.every((i) => i >= 0) && noteAt >= 0,
  `все варианты и подпись нашлись на листе (${at.filter((i) => i >= 0).length} из ${addresses.length})`,
);

let split = 0;
for (let k = 0; k < addresses.length; k += 1) {
  const start = at[k];
  let end = (k + 1 < at.length ? at[k + 1] : noteAt) - 1;
  while (end > start && joined[end] === " ") end -= 1; // не упереться в разделитель
  if (start < 0 || end < start) continue; // уже посчитано проверкой выше
  const a = pageOf(start);
  const b = pageOf(end);
  if (a !== b) {
    console.log(`      «${addresses[k]}»: начинается на стр.${a + 1}, кончается на стр.${b + 1}`);
    split += 1;
  }
}
ok(split === 0, "ни один вариант не разрезан между страницами");
ok(
  addresses.length === variants,
  `адресов собрано по числу вариантов (${addresses.length} из ${variants})`,
);

// Кто прислал и когда. Две проверки НЕ независимы, и это осознанно: вторая
// сформулирована как «имя рядом с датой», поэтому пропажа даты валит обе.
// Проверено мутацией. Разделять их значило бы спрашивать у листа «есть ли на
// нём хоть какое-то слово», а это не утверждение.
const all = pages.join("\n");
ok(/\d{2}\.\d{2}\.\d{4}/.test(all), "на листе есть дата подборки");
ok(/^\s*\S.*·\s*\d{2}\.\d{2}\.\d{4}/m.test(all), "и рядом с ней имя агентства");

console.log(failed === 0 ? "\nпечатный лист в порядке" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
