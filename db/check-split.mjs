// Проверяет db/split-sql.mjs сравнением с известно верным прогонщиком.
//
// db/rebuild.sh гоняет миграции через `psql -f`, и именно на этой схеме
// проходят все 42 набора тестов. Значит она и есть эталон. Этот скрипт
// собирает вторую базу теми же миграциями, но пооператорно — через разбор, —
// и сверяет структуры. Совпали — разбор ничего не склеил и не разрезал
// посередине тела функции.
//
// Сверяется структура, а не данные: отношения, столбцы с типами и
// значениями по умолчанию, функции, политики RLS, триггеры и ограничения.
// Политики здесь особенно важны: вся защита продукта — в них, и склеенный
// или потерянный оператор `create policy` обязан быть виден.
//
//   node db/check-split.mjs
//
// Нужен локальный Postgres на /tmp:55432 (как в README).

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "../web/node_modules/pg/lib/index.js";
import { split } from "./split-sql.mjs";
import { SIGNATURE } from "./signature.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "/tmp";
const PORT = 55432;
const REF = "partner_ref";
const TEST = "partner_split";

function psql(db, args) {
  return execFileSync(
    "psql",
    ["-h", HOST, "-p", String(PORT), "-U", "postgres", "-d", db, ...args],
    { encoding: "utf8" },
  );
}

async function connect(db) {
  const client = new pg.Client({ host: HOST, port: PORT, user: "postgres", database: db });
  await client.connect();
  return client;
}

// --- эталон: тот же путь, которым собирается база для тестов ---------------
console.log(`собираю эталон ${REF} через db/rebuild.sh`);
execFileSync(join(ROOT, "db", "rebuild.sh"), [], {
  env: { ...process.env, PGHOST: HOST, PGPORT: String(PORT), PGUSER: "postgres", DB: REF },
  stdio: "ignore",
});

// --- проверяемое: те же файлы, но пооператорно ------------------------------
console.log(`собираю ${TEST} пооператорно через разбор`);
psql("postgres", ["-q", "-c", `drop database if exists ${TEST} with (force)`]);
psql("postgres", ["-q", "-c", `create database ${TEST}`]);

const client = await connect(TEST);
let statements = 0;

async function run(file) {
  const text = await readFile(file, "utf8");
  for (const statement of split(text)) {
    try {
      // Каждый оператор отдельным запросом — то же, что делает psql -f, и
      // ровно то, чего не делает одна транзакция на файл.
      await client.query(statement);
    } catch (error) {
      throw new Error(
        `${file}: ${error.message}\n--- оператор ---\n${statement.slice(0, 400)}`,
      );
    }
    statements += 1;
  }
}

await run(join(ROOT, "db", "local_supabase_stub.sql"));
const dir = join(ROOT, "supabase", "migrations");
for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
  await run(join(dir, f));
}
await client.end();
console.log(`операторов применено: ${statements}`);

// --- подпись структуры ------------------------------------------------------

async function signature(db) {
  const c = await connect(db);
  const result = {};
  for (const [name, query] of Object.entries(SIGNATURE)) {
    const { rows } = await c.query(`select x from (${query}) t(x) order by 1`);
    result[name] = rows.map((r) => r.x);
  }
  await c.end();
  return result;
}

const [a, b] = await Promise.all([signature(REF), signature(TEST)]);

let bad = 0;
for (const name of Object.keys(SIGNATURE)) {
  const onlyRef = a[name].filter((x) => !b[name].includes(x));
  const onlyTest = b[name].filter((x) => !a[name].includes(x));
  const mark = onlyRef.length + onlyTest.length === 0 ? "ок" : "РАСХОЖДЕНИЕ";
  console.log(`  ${name}: эталон ${a[name].length}, разбор ${b[name].length} — ${mark}`);
  for (const x of onlyRef.slice(0, 5)) console.log(`      только в эталоне: ${x.slice(0, 160)}`);
  for (const x of onlyTest.slice(0, 5)) console.log(`      только в разборе: ${x.slice(0, 160)}`);
  bad += onlyRef.length + onlyTest.length;
}

psql("postgres", ["-q", "-c", `drop database if exists ${TEST} with (force)`]);
psql("postgres", ["-q", "-c", `drop database if exists ${REF} with (force)`]);

if (bad > 0) {
  console.error(`\nсхемы разошлись в ${bad} местах — разбор неверен`);
  process.exit(1);
}
console.log("\nсхемы совпали: разбор на операторы даёт то же, что psql -f");
