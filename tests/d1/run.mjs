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
import { readFileSync, mkdirSync } from 'node:fs';
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
      env: { DB: { type: 'd1', id: 'test-db' } },
    },
  }],
});

const db = await mf.getD1Database('DB');
const schema = readFileSync(resolve(root, 'db/d1/0001_schema.sql'), 'utf8');

// D1 принимает по одному запросу за раз, поэтому схема разбирается на
// отдельные команды.
//
// Комментарии снимаются ДО разбиения, а не после. В пояснениях встречается
// точка с запятой («роли это флаги одной записи; на этом держится…»), и
// разбиение по ней резало команду посередине — на этом упал второй прогон.
const statements = schema
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';');

for (const piece of statements) {
  const sql = piece.trim();
  if (!sql) continue;
  await db.exec(sql.replace(/\n/g, ' '));
}

// 3. Прогнать.
const response = await mf.dispatchFetch('http://test/');
const report = await response.json();
await mf.dispose();

for (const r of report.results) {
  console.log(`${r.ok ? '  ok   ' : '  ПАДАЕТ'} ${r.name}${r.ok || !r.note ? '' : ' — ' + r.note}`);
}
console.log(`\n  проверок: ${report.total}, провалов: ${report.failed}`);
process.exit(report.failed ? 1 : 0);
