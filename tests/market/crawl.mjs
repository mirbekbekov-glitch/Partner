/**
 * Весь путь целиком: скачать house.kg, разобрать, записать в настоящую D1.
 *
 * Запускается РУКАМИ и в npm test не входит: ходит в чужой интернет и
 * занимает минуту с лишним.
 *
 * Зачем он нужен сверх остальных проверок. Основной прогон пишет в базу
 * то, что разобрано из СНИМКА страницы; tests/market/live.mjs разбирает
 * живую страницу, но никуда её не кладёт. Между ними остаётся щель:
 * настоящие данные, которых в снимке нет (пустая площадь, отсутствующий
 * этаж, цена только в одной валюте), встречаются с ограничениями схемы
 * впервые — на бою. Эта проверка закрывает именно её.
 *
 * Запуск:  node tests/market/crawl.mjs
 *
 * Что считать поломкой: отказ записи, ноль строк при доступной площадке,
 * объявления без площади там, где она должна быть.
 */
import { build } from 'vite';
import { Miniflare } from '../../node_modules/cf/node_modules/miniflare/dist/src/index.js';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { statementsOf } from '../../db/d1/statements.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, '.test-build-market');
mkdirSync(out, { recursive: true });

await build({
  root,
  logLevel: 'error',
  configFile: false,
  resolve: {
    alias: {
      'server-only': resolve(root, 'tests/d1/stubs/empty.ts'),
      'cloudflare:workers': resolve(root, 'tests/d1/stubs/cloudflare-workers.ts'),
      'next/headers': resolve(root, 'tests/d1/stubs/next-headers.ts'),
      '@': root,
    },
  },
  build: {
    outDir: out,
    emptyOutDir: true,
    ssr: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: resolve(root, 'tests/market/crawl-entry.ts'),
      output: { entryFileNames: 'crawl.mjs', format: 'es' },
    },
  },
});

const mf = new Miniflare({
  workers: [{
    config: {
      name: 'market',
      compatibilityDate: '2026-11-22',
      compatibilityFlags: ['nodejs_compat'],
      manifest: {
        mainModule: 'crawl.mjs',
        modulesRoot: out,
        modules: {
          'crawl.mjs': { type: 'esm', contents: readFileSync(resolve(out, 'crawl.mjs'), 'utf8') },
        },
      },
      env: { DB: { type: 'd1', id: 'market-db' } },
    },
  }],
});

const db = await mf.getD1Database('DB');
const schemaDir = resolve(root, 'db/d1');
for (const file of readdirSync(schemaDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
  for (const sql of statementsOf(readFileSync(resolve(schemaDir, file), 'utf8'))) {
    try { await db.exec(sql); } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
}

console.log('  идёт обход, это примерно минута…\n');
const response = await mf.dispatchFetch('http://test/');
const { report, rows, sample, dates } = await response.json();
await mf.dispose();

for (const s of report.sections) {
  console.log(
    `  ${s.deal}/${s.kind}: страниц ${s.pages}, карточек ${s.cards}, `
    + `заведено ${s.added}, обновлено ${s.updated}`
    + (Object.keys(s.skipped).length ? `, отброшено ${JSON.stringify(s.skipped)}` : ''),
  );
}

console.log('\n  что легло в базу:');
for (const r of rows) {
  const usd = r.min_usd === null ? '—'
    : `${Math.round(r.min_usd / 100)}–${Math.round(r.max_usd / 100)} $`;
  console.log(
    `    ${r.deal_type}/${r.kind}${r.rent_period ? '/' + r.rent_period : ''}: `
    + `${r.n} шт, цена ${usd}, собственников ${r.owners}, с площадью ${r.with_area}`,
  );
}
console.log('\n  образец:', JSON.stringify(sample[0]));
if (dates?.length) {
  console.log('\n  даты публикации у собственников:');
  for (const d of dates) console.log(`    ${d.posted_at} — ${d.address ?? ''}`);
}
console.log(`\n  живых в индексе: ${report.live}, дат публикации получено: ${report.dated}`);
console.log(`  площадка ${report.unreachable ? 'НЕ ОТВЕТИЛА' : 'ответила'}`);
process.exit(report.unreachable || report.live === 0 ? 1 : 0);
