// Сборщик: кладёт объявления в пул кандидатов.
//
// Адаптеров площадок здесь нет (см. README). Этот запуск читает записи из
// файла и проходит ровно тем путём, которым пойдёт настоящий адаптер:
// подключается, понижает права до роли collector и вызывает две функции.
// Если права где-то разъедутся, это будет видно здесь, а не в бою.
//
//   node collector/run.mjs collector/fixtures/example.json

import { readFileSync } from "node:fs";
import pg from "pg";

const envFile = new URL("../web/.env", import.meta.url);
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // Файла может не быть: тогда переменные берутся из окружения.
}

const path = process.argv[2];
if (!path) {
  console.error("укажите файл с объявлениями: node collector/run.mjs <файл>");
  process.exit(2);
}

const batch = JSON.parse(readFileSync(path, "utf8"));
const source = batch.source;
const listings = batch.listings ?? [];

if (!source || listings.length === 0) {
  console.error("в файле должны быть source и непустой listings");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let added = 0;
let failed = 0;
const seen = [];

try {
  await client.query("begin");
  // Те же права, что будут у службы в бою. Понижение делается здесь, а не
  // настройкой подключения, чтобы его нельзя было забыть.
  await client.query("set local role collector");

  for (const item of listings) {
    const payload = { ...item, source };
    try {
      const { rows } = await client.query(
        "select app.upsert_candidate($1::jsonb) as id",
        [JSON.stringify(payload)],
      );
      seen.push(String(item.external_id));
      added += 1;
      process.stdout.write(`  принято ${item.external_id} → ${rows[0].id}\n`);
    } catch (error) {
      // Одно кривое объявление не должно ронять весь проход: площадка отдаёт
      // мусор регулярно, и терять из-за него остальные записи нельзя.
      failed += 1;
      process.stdout.write(`  ОТКЛОНЕНО ${item.external_id}: ${error.message}\n`);
      await client.query("rollback");
      await client.query("begin");
      await client.query("set local role collector");
    }
  }

  const { rows } = await client.query(
    "select app.mark_candidates_gone($1::listing_source, $2::text[]) as gone",
    [source, seen],
  );
  await client.query("commit");

  console.log(
    `\nисточник ${source}: принято ${added}, отклонено ${failed}, помечено исчезнувшими ${rows[0].gone}`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`проход прерван: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
