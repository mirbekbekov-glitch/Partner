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
const BASE = "http://localhost:3000";
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
await ask.locator('input[name="phone"]').fill("0700 000 001");
await ask.locator("button").click();
await page.waitForSelector(".act-ok, .act-err");
const notice = await page.locator(".act-ok, .act-err").first().innerText();
const code = notice.match(/\b(\d{6})\b/)?.[1];
if (!code) throw new Error(`код не выдан: ${notice}\nв разработке помогает: psql -d partner -c 'delete from login_codes'`);
const enter = page.locator("section.card").nth(1);
await enter.locator('input[name="phone"]').fill("0700000001");
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
log("объект:", await page.locator("h1").innerText(),
    "| фотографий сейчас:", await page.locator(".shot").count());
await page.screenshot({ path: `${SHOT}/photo-before.png`, fullPage: true });

// --- загрузка трёх снимков --------------------------------------------------
await page.locator('input[type="file"]').setInputFiles(files);
await page.locator('form:has(input[type="file"]) button').click();
await page.waitForSelector(".act-ok, .act-err", { timeout: 60000 });
log("загрузка →", await page.locator(".act-ok, .act-err").first().innerText());

await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
const shots = await page.locator(".shot").count();
log("фотографий в галерее:", shots);
await page.screenshot({ path: `${SHOT}/photo-gallery.png`, fullPage: true });

// Картинка действительно отдаётся, а не висит битой.
const img = page.locator(".shot img").first();
const natural = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
log("первая фотография отдаётся:", `${natural.w}×${natural.h}`);

// --- не-изображение ---------------------------------------------------------
await page.locator('input[type="file"]').setInputFiles([fake]);
await page.locator('form:has(input[type="file"]) button').click();
await page.waitForSelector(".act-err, .act-ok", { timeout: 30000 });
log("документ вместо фотографии →", await page.locator(".act-err, .act-ok").first().innerText());

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
const key = (await page.locator(".shot img").first().getAttribute("src")).replace("/cabinet/photo/", "");
const anon = await browser.newPage();
const pub = await anon.goto(`${BASE}/photo/${key}`);
log(`публичная ссылка на фотографию опубликованного объекта: HTTP ${pub.status()}`);
const cab = await anon.goto(`${BASE}/cabinet/photo/${key}`);
log(`кабинетная ссылка без входа: HTTP ${cab.status()}`);

await browser.close();
log("проход завершён");
