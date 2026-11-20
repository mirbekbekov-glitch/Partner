// Проход по house.kg: страница поиска → страницы объявлений → пул кандидатов.
//
//   node collector/collect.mjs --limit 10
//   node collector/collect.mjs --limit 5 --no-phones --dry
//
// Что здесь сознательно сделано медленно и скучно:
//
//   — пауза между запросами, по умолчанию полторы секунды. Сборщик, который
//     кладёт площадку, лишает доступа и себя, и всех остальных;
//   — ни одного запроса к путям, закрытым в robots.txt сайта. Проверка стоит
//     до запроса, а не в комментарии;
//   — --limit обязателен по смыслу: проход без предела однажды запустят
//     случайно, и это будет заметно с той стороны.
//
// Права понижаются до роли collector, как и в run.mjs: ошибка в правах видна
// здесь, а не в бою.

import { readFileSync } from "node:fs";
import pg from "pg";
import {
  isAllowedPath,
  origin,
  parseItemPage,
  parseListPage,
  source,
} from "./adapters/house-kg.mjs";

try {
  for (const line of readFileSync(new URL("../web/.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // Файла может не быть: тогда переменные берутся из окружения.
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limit = Number(value("--limit", "10"));
const pauseMs = Number(value("--pause", "1500"));
const searchPath = value("--path", "/kupit-kvartiru?region=1&town=2");
const phonesFromText = !flag("--no-phones");
const dry = flag("--dry");

// Нейтральное имя клиента. Выдавать себя за браузер или за чужого робота —
// ровно то враньё, из-за которого сборщикам и закрывают доступ. Только
// латиница: заголовки HTTP кириллицу не принимают.
const USER_AGENT = "PartnerPlatformCollector/0.1 (real estate platform, Bishkek)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPath(path) {
  if (!isAllowedPath(path)) {
    throw new Error(`путь ${path} закрыт правилами площадки, запрос не делается`);
  }
  const response = await fetch(`${origin}${path}`, {
    headers: { "user-agent": USER_AGENT, "accept-language": "ru" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
if (!dry) await client.connect();

let taken = 0;
let skipped = 0;
const seen = [];

try {
  process.stdout.write(`страница поиска ${searchPath}\n`);
  const listHtml = await fetchPath(searchPath);
  const urls = parseListPage(listHtml).slice(0, Math.max(limit, 1));
  process.stdout.write(`объявлений на странице: ${urls.length}, берём ${urls.length}\n\n`);

  for (const url of urls) {
    await sleep(pauseMs);
    const path = url.replace(origin, "");
    let record;
    try {
      const html = await fetchPath(path);
      record = parseItemPage(html, url, { phonesFromText });
    } catch (error) {
      skipped += 1;
      process.stdout.write(`  пропущено ${path}: ${error.message}\n`);
      continue;
    }

    if (!record) {
      skipped += 1;
      process.stdout.write(`  пропущено ${path}: на странице нет объявления\n`);
      continue;
    }

    seen.push(record.external_id);
    const mark = record.author === "owner" ? "собственник" : record.author;
    const phone = record.phone ? ", телефон из текста" : "";
    process.stdout.write(
      `  ${record.external_id}: ${record.price ?? "?"} ${record.currency}, ${mark}${phone}\n`,
    );

    if (dry) {
      taken += 1;
      continue;
    }

    await client.query("begin");
    await client.query("set local role collector");
    await client.query("select app.upsert_candidate($1::jsonb)", [
      JSON.stringify({ ...record, source }),
    ]);
    await client.query("commit");
    taken += 1;
  }

  if (!dry && seen.length > 0) {
    await client.query("begin");
    await client.query("set local role collector");
    const { rows } = await client.query(
      "select app.mark_candidates_gone($1::listing_source, $2::text[]) as gone",
      [source, seen],
    );
    await client.query("commit");
    process.stdout.write(`\nпомечено исчезнувшими: ${rows[0].gone}\n`);
  }

  process.stdout.write(
    `\nисточник ${source}: принято ${taken}, пропущено ${skipped}${dry ? " (проход без записи)" : ""}\n`,
  );
} catch (error) {
  if (!dry) await client.query("rollback").catch(() => {});
  console.error(`проход прерван: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!dry) await client.end();
}
