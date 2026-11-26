/**
 * Проверка сжатия снимков — в настоящем браузере.
 *
 * Зачем отдельно от npm test. Сжатие делает браузер: createImageBitmap,
 * OffscreenCanvas и кодировщик WebP. В Worker'е, где идёт основной прогон,
 * ничего этого нет, то есть основными тестами эта часть непокрываема в
 * принципе — а она не мелочь: от неё зависит, уедет снимок на 8 МБ или на
 * 400 КБ.
 *
 * В выкладку не включено намеренно: ставить браузер в каждую выкладку —
 * полминуты на то, что меняется раз в полгода. Запускать руками, когда
 * правится lib/photo-resize.ts:
 *
 *   npx esbuild lib/photo-resize.ts --bundle --format=esm --outfile=/tmp/resize.mjs
 *   node tests/browser/resize.mjs /tmp/resize.mjs
 *
 * Нужен Playwright с Chromium. В агентском контейнере он лежит в
 * /opt/node-tools; на своей машине — npm i -g playwright.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const bundle = process.argv[2];
if (!bundle) {
  console.error('Укажите собранный модуль: node tests/browser/resize.mjs /tmp/resize.mjs');
  process.exit(2);
}

// Playwright ищется и в проекте, и в общей папке контейнера: он не
// зависимость проекта, и привязываться к одному пути незачем.
const require = createRequire(import.meta.url);
let chromium;
for (const where of ['playwright', '/opt/node-tools/node_modules/playwright/index.js']) {
  try { ({ chromium } = require(where)); break; } catch { /* дальше */ }
}
if (!chromium) {
  console.error('Playwright не найден: npm i -g playwright');
  process.exit(2);
}

const module = readFileSync(bundle, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const out = await page.evaluate(async (src) => {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const { prepare, size } = await import(url);

  // Настоящий снимок «с телефона»: 3000×2000, JPEG, с шумом — иначе
  // однотонная картинка сожмётся в десяток байт и ничего не покажет.
  const c = document.createElement('canvas');
  c.width = 3000; c.height = 2000;
  const g = c.getContext('2d');
  const img = g.createImageData(3000, 2000);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i / 97) % 256;
    img.data[i + 1] = (i / 13) % 256;
    img.data[i + 2] = (i * 7) % 256;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const file = new File([blob], 'IMG_1234.jpg', { type: 'image/jpeg' });

  const ready = await prepare(file);

  const dims = async (b) => {
    const bm = await createImageBitmap(b);
    return `${bm.width}x${bm.height}`;
  };

  const head = new Uint8Array(await ready.full.slice(0, 12).arrayBuffer());
  const ascii = (f, n) => String.fromCharCode(...head.slice(f, f + n));

  return {
    before: ready.before, after: ready.after,
    human: `${size(ready.before)} → ${size(ready.after)}`,
    fullDims: await dims(ready.full),
    thumbDims: ready.thumb ? await dims(ready.thumb) : null,
    thumbBytes: ready.thumb ? ready.thumb.size : null,
    isWebp: ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP',
  };
}, module);

await browser.close();

let failed = 0;
const ok = (name, cond) => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok   ' : 'НЕ   '} ${name}`);
};

console.log(`  ${out.human}, полный ${out.fullDims}, миниатюра ${out.thumbDims}`);

ok('снимок стал меньше', out.after < out.before);
ok('длинная сторона полного — 2000', out.fullDims === '2000x1333');
ok('длинная сторона миниатюры — 640', out.thumbDims === '640x427');
// Формат важен не сам по себе: именно WebP распознаёт проверка по
// содержимому в lib/db/photos.ts. Сменился бы формат — сервер отверг бы
// собственный же файл.
ok('полный снимок — WebP (его и распознаёт sniff)', out.isWebp);
ok('миниатюра заметно меньше полного', out.thumbBytes < out.after);

process.exit(failed === 0 ? 0 : 1);
