// Проход по загрузке фотографий настоящим браузером.
//
// Проверяется то, чего не видно из кода: что файл доходит от формы до
// хранилища, что галерея после этого показывает именно загруженное, что
// обложка меняется и что удаление убирает и запись, и файл.
//
//   node scripts/walk-photos.mjs
const pw = await import(process.env.PLAYWRIGHT ?? "playwright");
const { chromium } = pw.default ?? pw;
import sharp from "sharp";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOT = process.env.SHOT_DIR ?? "/tmp/partner-shots";
// Тот же обход нужен по двум стендам: обычный Next (порт 3000) и воркер
// (порт 3001). Прошитый адрес означал бы, что воркер проверяется не этим
// обходом, а похожим на него.
const BASE = process.env.WALK_BASE ?? "http://localhost:3000";
const log = (...a) => console.log(...a);

// Снимки «с телефона»: большие, с координатами в EXIF.
const dir = await mkdtemp(join(tmpdir(), "walk-photos-"));
const files = [];
for (const [i, color] of ["#4a7fa5", "#a5744a", "#6a4aa5"].entries()) {
  const buf = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: color } })
    .withExif({ IFD0: { Make: "Acme", Model: "Phone 12" },
                GPS: { GPSLatitude: "42/1 52/1 30/1", GPSLatitudeRef: "N",
                       GPSLongitude: "74/1 36/1 0/1", GPSLongitudeRef: "E" } })
    .jpeg({ quality: 92 }).toBuffer();
  const path = join(dir, `IMG_${4820 + i}.JPG`);
  await writeFile(path, buf);
  files.push(path);
}
// И документ, притворяющийся фотографией.
const fake = join(dir, "spreadsheet.jpg");
await writeFile(fake, "<html><script>alert(1)</script></html>");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
page.on("dialog", (d) => d.accept());

// --- вход -----------------------------------------------------------------
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

// --- объект без фотографий -------------------------------------------------
await page.goto(`${BASE}/cabinet/objects`, { waitUntil: "networkidle" });
// Нужен объект с ДЕЙСТВУЮЩИМ договором: фотографии ведёт listing-агент
// мандата (инвариант 11), и у черновика без договора формы загрузки нет —
// правильно, что нет.
const row = page
  .locator('.row:has(button:text("Подтвердить актуальность")):has(.chip.ok)')
  .first();
const href = await row.locator("h3 a").getAttribute("href");
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const had = await page.locator(".shot").count();
log("объект:", await page.locator("h1").innerText(), "| фотографий сейчас:", had);
await page.screenshot({ path: `${SHOT}/photo-before.png`, fullPage: true });

// --- загрузка трёх снимков --------------------------------------------------
await page.locator('input[type="file"]').setInputFiles(files);
await page.locator('form:has(input[type="file"]) button').click();
await page.waitForSelector(".act-ok, .act-err", { timeout: 60000 });
log("загрузка →", await page.locator(".act-ok, .act-err").first().innerText());

await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const shots = await page.locator(".shot").count();
log("фотографий в галерее:", shots, `(было ${had}, загружено 3)`);
if (shots !== had + 3) {
  throw new Error(`в галерее ${shots} фотографий, а должно быть ${had + 3}`);
}
await page.screenshot({ path: `${SHOT}/photo-gallery.png`, fullPage: true });

// Картинка действительно отдаётся, а не висит битой — и перекодирована, а не
// пропущена насквозь. Исходники сняты на 4032×3024; если наружу уходит
// исходный размер, значит байты не наши, и весь инвариант 11 держится на
// честном слове. Раньше эта строка только печаталась.
// Именно ПОСЛЕДНЯЯ: первая — это снимок из прошлого прогона, и проверка по
// ней ничего не говорит про загрузку, которая только что произошла. Мутация
// «кодировщик пропускает байты насквозь» проходила проверку по первой.
const img = page.locator(".shot img").last();
// Ключ запоминается здесь же: публичная сторона должна проверяться на
// фотографии, которую загрузил ЭТОТ прогон. Раньше брался первый снимок в
// галерее — то есть оставшийся от прошлого прогона, возможно на другом
// стенде. База у стендов одна, а хранилища разные, и такой снимок честно
// отдавал 404: байты лежат в бакете воркера, а не на диске. Проверка
// сообщала о поломке там, где поломки нет.
const key = (await img.getAttribute("src")).replace("/cabinet/photo/", "");
const natural = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
log("только что загруженная фотография отдаётся:", `${natural.w}×${natural.h}`);
if (natural.w === 0 || natural.h === 0) {
  throw new Error("фотография не отдаётся: браузер показывает битую картинку");
}
if (natural.w > 2000 || natural.h > 2000) {
  throw new Error(
    `фотография ${natural.w}×${natural.h} больше предела 2000: перекодирование не сработало`,
  );
}

// --- не-изображение ---------------------------------------------------------
await page.locator('input[type="file"]').setInputFiles([fake]);
await page.locator('form:has(input[type="file"]) button').click();
await page.waitForSelector(".act-err, .act-ok", { timeout: 30000 });
const verdict = await page.locator(".act-err, .act-ok").first().innerText();
log("документ вместо фотографии →", verdict);
// Проверяется не только текст, но и то, что в галерее ничего не прибавилось:
// сообщение об отказе и отказ — разные вещи.
if (!/не изображение|повреждено/.test(verdict)) {
  throw new Error(`документ с расширением .jpg не отклонён: ${verdict}`);
}
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const afterFake = await page.locator(".shot").count();
if (afterFake !== shots) {
  throw new Error(`документ всё же попал в галерею: было ${shots}, стало ${afterFake}`);
}

// --- обложка ----------------------------------------------------------------
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const second = page.locator(".shot").nth(1);
const before = await page.locator(".shot.cover img").getAttribute("src");
// Успех приходит уведомлением сверху: кнопка исчезает вместе с формой,
// потому что эта фотография стала обложкой.
await second.locator('form:has(button:text("На обложку")) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const after = await page.locator(".shot.cover img").getAttribute("src");
log("обложка сменилась:", before !== after);

// --- удаление ---------------------------------------------------------------
await page.locator(".shot").first().locator('form:has(button:text("Удалить")) button').click();
await page.waitForSelector(".ok-banner, .act-err", { timeout: 20000 });
log("удаление →", await page.locator(".ok-banner, .act-err").first().innerText());
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
log("после удаления фотографий:", await page.locator(".shot").count());
await page.screenshot({ path: `${SHOT}/photo-after.png`, fullPage: true });

// --- публичная сторона -------------------------------------------------------
// Инвариант 11 проверяется С ДВУХ СТОРОН, и это не педантизм. Раньше здесь
// печаталось «фотографию опубликованного объекта», а объект выбирается по
// действующему договору, не по публикации: на черновике строка сообщала 404
// как про опубликованный объект. То есть называла не то, что проверила — и
// 404 выглядел бы поломкой, а 200 (настоящая утечка) прошёл бы незамеченным.
//
// Поэтому обе стороны проверяются на одном и том же файле: сняли с каталога —
// 404, вернули в каталог — 200. Одна сторона без другой ничего не значит:
// маршрут, который всегда отвечает 404, прошёл бы проверку «черновик закрыт».
const anon = await browser.newPage();
const publicStatus = async () => (await anon.goto(`${BASE}/photo/${key}`)).status();

const isPublished = async () =>
  (await page.locator(".chip.published").count()) > 0;

// Ждём не баннер, а само наблюдаемое изменение: у разных действий баннеры
// разные, а чип публикации — то, ради чего действие и нажимают.
const act = async (label, wantPublished) => {
  await page.locator(`form:has(button:text-is("${label}")) button`).first().click();
  await page.waitForTimeout(500);
  for (let i = 0; i < 20; i += 1) {
    await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
    if ((await isPublished()) === wantPublished) return;
    await page.waitForTimeout(500);
  }
  const err = await page.locator(".act-err, .warn-banner").first();
  const why = (await err.count()) > 0 ? await err.innerText() : "без сообщения";
  throw new Error(`действие «${label}» не изменило состояние публикации: ${why}`);
};

if (await isPublished()) await act("Снять с каталога", false);
if (await isPublished()) throw new Error("объект не удалось снять с каталога");

const asDraft = await publicStatus();
log(`черновик: публичная ссылка HTTP ${asDraft} (ожидается 404)`);
if (asDraft !== 404) {
  throw new Error(`фотография НЕопубликованного объекта отдаётся наружу: HTTP ${asDraft}`);
}

await act("В каталог", true);
if (!(await isPublished())) {
  throw new Error("объект не удалось опубликовать, вторая сторона не проверена");
}
const asPublished = await publicStatus();
log(`в каталоге: публичная ссылка HTTP ${asPublished} (ожидается 200)`);
if (asPublished !== 200) {
  throw new Error(`фотография опубликованного объекта не отдаётся: HTTP ${asPublished}`);
}

// Вернуть как было: обход не должен менять состояние базы между прогонами.
await act("Снять с каталога", false);

const cab = await anon.goto(`${BASE}/cabinet/photo/${key}`);
log(`кабинетная ссылка без входа: HTTP ${cab.status()} (ожидается 401)`);
if (cab.status() !== 401) {
  throw new Error(`кабинетная ссылка без входа отдала HTTP ${cab.status()}`);
}

await browser.close();
log("проход завершён");
