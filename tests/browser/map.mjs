/**
 * Булавки карты — в настоящем браузере.
 *
 * Зачем отдельно от npm test. Ни типы, ни прогон в Worker'е не видят
 * того, что делает с иконкой Leaflet. Первая версия этой карты рисовала
 * цену голым текстом поверх карты: Leaflet задаёт иконке 12×12
 * пикселей, если размер не задан, и подпись из неё вываливалась. Всё
 * было зелёным, а на экране — каша. Поймал это только снимок.
 *
 * В выкладку не включено намеренно: браузер в каждой выкладке — это
 * полминуты ради того, что меняется редко. Запускать руками, когда
 * правится app/CatalogMap.tsx, lib/map-cluster.ts или стили карты:
 *
 *   node tests/browser/map.mjs
 *
 * Нужен Playwright с Chromium. В агентском контейнере он уже стоит; на
 * своей машине — npm i -g playwright.
 */
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);

let chromium;
for (const where of ['playwright', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require_(where)); break; } catch { /* ищем дальше */ }
}
if (!chromium) {
  console.error('Нужен Playwright: npm i -g playwright');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'mapcheck-'));

// Сетку берём настоящую, из модуля: проверять копию её кода смысла нет.
execFileSync('npx', ['esbuild', 'lib/map-cluster.ts', '--bundle', '--format=esm',
  '--outfile=' + join(dir, 'cluster.mjs')], { cwd: root, stdio: 'ignore' });

copyFileSync(join(root, 'node_modules/leaflet/dist/leaflet.js'), join(dir, 'leaflet.js'));
copyFileSync(join(root, 'node_modules/leaflet/dist/leaflet.css'), join(dir, 'leaflet.css'));

// Стили карты — из настоящего файла, от заголовка раздела и до конца.
const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
writeFileSync(join(dir, 'map.css'), css.slice(css.indexOf('/* Каталог на карте')));

writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="ru"><head>
<meta charset="utf-8">
<link rel="stylesheet" href="leaflet.css"><link rel="stylesheet" href="map.css">
<style>:root{--bg:#fff;--fg:#10233f;--muted:#6b7a90;--line:#dfe5ee;--panel:#fff;
--sunk:#f3f6fa;--accent:#c8202e;--r-full:999px;--r-md:10px}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg)}
</style></head><body>
<div class="map-page"><div class="map-side"><div class="map-head">
<b class="num">Найдено 4</b></div><div class="map-list" id="list"></div></div>
<div class="map-canvas" id="map"></div></div>
<script src="leaflet.js"></script>
<script type="module">
import { cluster, middle, shortPrice } from './cluster.mjs';
const units = { mln: ' млн', thd: ' тыс.', som: ' с' };
const pts = [
  { id:'1', latitude:42.8746, longitude:74.6122, price:7345800, currency:'KGS' },
  { id:'2', latitude:42.8752, longitude:74.6131, price:84000, currency:'USD' },
  { id:'3', latitude:42.8758, longitude:74.6140, price:450, currency:'USD' },
  { id:'4', latitude:42.8600, longitude:74.5800, price:10900000, currency:'KGS' },
];
const pin = (cls, text) => L.divIcon({ className: cls,
  html: '<span>' + text + '</span>', iconSize: undefined });
const m = L.map('map', { center:[42.8746,74.6122], zoom:13 });
m.attributionControl.setPrefix(false);
const group = L.layerGroup().addTo(m);
function draw(){
  group.clearLayers();
  for (const cell of cluster(pts, p => m.latLngToContainerPoint([p.latitude,p.longitude]), 64)) {
    if (cell.items.length === 1) {
      const p = cell.items[0];
      L.marker([p.latitude,p.longitude],{icon:pin('map-price',shortPrice(p.price,p.currency,units))}).addTo(group);
    } else {
      L.marker(middle(cell.items),{icon:pin('map-cluster',String(cell.items.length))}).addTo(group);
    }
  }
}
draw(); m.on('zoomend moveend', draw);
window.__mapFor = (lat, lng) => m.latLngToContainerPoint([lat, lng]);
window.__drawn = true;
</script></body></html>`);

const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html';
  const type = name.endsWith('.css') ? 'text/css'
    : name.endsWith('.mjs') || name.endsWith('.js') ? 'text/javascript'
    : 'text/html';
  try {
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(readFileSync(join(dir, name)));
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

let failures = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'ok   ' : 'ПАДАЕТ'} ${name}${ok || !note ? '' : ` — ${note}`}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction('window.__drawn === true', { timeout: 15000 });
await page.waitForTimeout(800);

check('на странице нет ошибок', errors.length === 0, errors.join('; '));

const pill = await page.locator('.map-price > span').first().boundingBox();
// Отдельной булавкой стоит ровно одна точка: три остальные рядом и
// собираются в кружок. Значит, .map-price в DOM один, и проверка ниже
// сравнивает именно его координату.
check('отдельная булавка одна, остальные в сгущении',
  (await page.locator('.map-price').count()) === 1
  && (await page.locator('.map-cluster').count()) === 1);
// Подпись «10.9 млн с» — это шесть-семь знаков: плашка уже сорока
// пикселей означает, что текст из неё вывалился, как было в первой версии.
check('плашка булавки обнимает подпись',
  Boolean(pill) && pill.width > 40 && pill.height > 16,
  JSON.stringify(pill));

const circle = await page.locator('.map-cluster > span').first().boundingBox();
check('кружок сгущения нарисован кружком',
  Boolean(circle) && Math.abs(circle.width - circle.height) < 2 && circle.width > 24,
  JSON.stringify(circle));

// Булавка стоит СЕРЕДИНОЙ на своей точке — на той самой широте и
// долготе, а не рядом с ней. Сравниваем с координатой, которую считает
// сама карта, а не с рамкой иконки: иконка съезжает вместе с подписью,
// и проверка «подпись в середине иконки» сошлась бы при любом промахе.
const offset = await page.evaluate(() => {
  const span = document.querySelector('.map-price > span');
  const box = span.getBoundingClientRect();
  const canvas = document.getElementById('map').getBoundingClientRect();
  // Точка «450»: единственная, что стоит отдельной булавкой в правом
  // верхнем углу группы, — её координаты известны странице.
  const want = window.__mapFor(42.8600, 74.5800);
  return {
    dx: (box.left + box.width / 2) - (canvas.left + want.x),
    dy: (box.top + box.height / 2) - (canvas.top + want.y),
  };
});
check('булавка стоит серединой на своей координате',
  Math.abs(offset.dx) < 2 && Math.abs(offset.dy) < 2, JSON.stringify(offset));

check('чужого флага в подписи карты нет',
  !(await page.locator('.leaflet-control-attribution').innerText()).includes('Leaflet'));

const shot = join(dir, 'map.png');
await page.screenshot({ path: shot });
console.log(`\n  Снимок: ${shot}`);

await browser.close();
server.close();

console.log(`\n  проверок: 6, провалов: ${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
