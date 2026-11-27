/**
 * Прогон инвариантов на настоящей D1.
 *
 * Что здесь происходит. Слой доступа написан под Worker: он берёт привязку
 * из cloudflare:workers и cookie из next/headers. Поэтому тест собирается
 * в Worker — те два модуля подменяются заглушками, всё остальное идёт как
 * есть, — и запускается в Miniflare, где D1 настоящая.
 *
 * Запуск: node tests/d1/run.mjs
 */
import { build } from 'vite';
import { Miniflare } from '../../node_modules/cf/node_modules/miniflare/dist/src/index.js';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { statementsOf } from '../../db/d1/statements.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, '.test-build');

mkdirSync(out, { recursive: true });

// 1. Собрать тест в один файл Worker.
await build({
  root,
  logLevel: 'error',
  // Свой конфиг проекта здесь не нужен: он тянет плагины Next, а тесту
  // нужен один файл Worker.
  configFile: false,
  resolve: {
    alias: {
      'server-only': resolve(root, 'tests/d1/stubs/empty.ts'),
      'cloudflare:workers': resolve(root, 'tests/d1/stubs/cloudflare-workers.ts'),
      'next/headers': resolve(root, 'tests/d1/stubs/next-headers.ts'),
      // Отправка писем — единственное в слое входа, что нельзя выполнить вне
      // Worker: она идёт через привязку Cloudflare. Подменяется ровно этот
      // модуль, вся остальная логика входа проходит настоящая.
      '@/lib/db/email': resolve(root, 'tests/d1/stubs/email.ts'),
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
      input: resolve(root, 'tests/d1/suite.ts'),
      output: { entryFileNames: 'suite.mjs', format: 'es' },
    },
  },
});

// 2. Поднять Worker с настоящей D1 и применить схему.
const mf = new Miniflare({
  workers: [{
    config: {
      name: 'suite',
      compatibilityDate: '2026-11-22',
      compatibilityFlags: ['nodejs_compat'],
      manifest: {
        mainModule: 'suite.mjs',
        modulesRoot: out,
        modules: {
          'suite.mjs': { type: 'esm', contents: readFileSync(resolve(out, 'suite.mjs'), 'utf8') },
        },
      },
      env: {
        DB: { type: 'd1', id: 'test-db' },
        // Хранилище снимков: в прогоне оно настоящее, Miniflare держит его
        // в памяти. Проверять загрузку по заглушке бессмысленно — вся суть
        // в том, что именно принимает и отвергает хранилище.
        PHOTOS: { type: 'r2', name: 'test-photos' },
        // Вторая база — снимок каталога старого сайта. В боевом её
        // наполняет чужой Worker; здесь её наполняет сам прогон, но база
        // настоящая: перенос ходит в неё тем же запросом, что и в бою.
        CATALOG: { type: 'd1', id: 'test-catalog' },
      },
    },
  }],
});

const db = await mf.getD1Database('DB');
const schemaDir = resolve(root, 'db/d1');
const schemaFiles = readdirSync(schemaDir)
  .filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

// Файлы схемы по порядку имён. Разбор — общий с боевым применением
// (db/d1/statements.mjs): резать её одинаково обязательно, иначе
// проверенное здесь и выложенное наружу разойдутся.
//
// «duplicate column name» пропускается ровно по той же причине, что и в
// боевом применении: ALTER в SQLite не умеет IF NOT EXISTS.
for (const file of schemaFiles) {
  const text = readFileSync(resolve(schemaDir, file), 'utf8');
  for (const sql of statementsOf(text)) {
    try {
      await db.exec(sql);
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
}

// 2б. Снимок каталога старого сайта: таблица такая же, как в боевой базе
// liberterra-catalog, тело подкладывает сам тест.
const catalog = await mf.getD1Database('CATALOG');
await catalog.exec(
  'create table if not exists public_catalog_snapshot ('
  + ' singleton integer primary key, generated_at_ms integer not null,'
  + ' content_type text, body text not null, sha256 text, row_count integer)',
);

// 3. Прогнать.
const response = await mf.dispatchFetch('http://test/');
const report = await response.json();
await mf.dispose();

for (const r of report.results) {
  console.log(`${r.ok ? '  ok   ' : '  ПАДАЕТ'} ${r.name}${r.ok || !r.note ? '' : ' — ' + r.note}`);
}
console.log(`\n  проверок: ${report.total}, провалов: ${report.failed}`);
process.exit(report.failed ? 1 : 0);
