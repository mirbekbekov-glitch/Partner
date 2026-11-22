// Применяет миграции к размещённому проекту Supabase через Management API.
//
// Зачем через API, а не psql: строка подключения к базе — секрет, который не
// должен лежать ни в репозитории, ни в переменных окружения сессии. Токен
// Management API хранится как сетевой секрет окружения и подставляется прокси
// в заголовок: ни этот скрипт, ни тот, кто его запускает, значения не видят.
//
//   NODE_USE_ENV_PROXY=1 SUPABASE_PROJECT_REF=xxxx node db/push-hosted.mjs --check
//   NODE_USE_ENV_PROXY=1 SUPABASE_PROJECT_REF=xxxx node db/push-hosted.mjs --apply
//   NODE_USE_ENV_PROXY=1 SUPABASE_PROJECT_REF=xxxx node db/push-hosted.mjs --reset --apply
//
// NODE_USE_ENV_PROXY нужен там, где исходящие запросы идут через прокси:
// `fetch` в node, в отличие от curl, сам HTTPS_PROXY не читает. Выставить его
// внутри скрипта нельзя — undici читает переменную раньше нашего кода, —
// поэтому скрипт проверяет её сам и говорит, чего не хватает. Иначе ошибка
// выглядела бы как «api.supabase.com не найден», то есть указывала бы не туда.
//
//   --check     только посмотреть, что в базе сейчас. Ничего не пишет;
//   --apply     применить supabase/migrations/*.sql по порядку;
//   --reset     ПЕРЕД применением снести схемы public и app целиком;
//   --schedule  зарегистрировать плановые работы (db/install_schedule.sql);
//   --verify    сверить устройство размещённой базы с местной.
//
// --verify отвечает на единственный вопрос, который на самом деле важен после
// выкладывания: та ли это схема, на которой проходят тесты. Сравниваются
// отношения, столбцы, функции, политики RLS, триггеры и ограничения. Местная
// база берётся из VERIFY_DB (по умолчанию partner) через psql.
//
// `db/local_supabase_stub.sql` здесь НЕ применяется, и это важно: он
// воспроизводит auth.uid() и роли Supabase для местного Postgres, а в
// настоящем Supabase они уже есть. Применить его значило бы подменить
// настоящие функции самодельными.
//
// Миграции не идемпотентны: это одноразовый прогон на чистой схеме, а не
// инструмент «догнать до текущего состояния». Журнала применённых миграций в
// проекте нет, поэтому единственное надёжное состояние — известное: пусто,
// затем все миграции по порядку. Отсюда и --reset.
//
// ПОЧЕМУ ФАЙЛ ИНОГДА ИДЁТ ПООПЕРАТОРНО. Management API выполняет запрос одной
// транзакцией, а миграции опираются на пооператорную фиксацию: 0039 добавляет
// значение в перечисление и ниже в том же файле его использует, что Postgres
// внутри одной транзакции запрещает («unsafe use of new value»). Местный
// прогонщик этого не видит, потому что `psql -f` фиксирует каждый оператор.
//
// Поэтому файл сначала посылается целиком — так быстрее, — и только при
// отказе разбирается на операторы и посылается по одному, то есть ровно так,
// как его гоняет psql. Это безопасно: отказ одной транзакции откатывает файл
// целиком, проверено на 0039 — ни таблицы, ни новых значений перечисления
// после падения не осталось.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { split } from "./split-sql.mjs";
import { SIGNATURE, PARTS } from "./signature.mjs";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF = process.env.SUPABASE_PROJECT_REF;
if (!REF) {
  console.error("SUPABASE_PROJECT_REF не задан: неизвестно, в какой проект писать.");
  process.exit(1);
}

if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  console.error(
    "исходящие запросы идут через прокси (HTTPS_PROXY задан), а `fetch` в node\n" +
      "сам его не читает. Запускайте так:\n\n" +
      "  NODE_USE_ENV_PROXY=1 SUPABASE_PROJECT_REF=... node db/push-hosted.mjs --check\n",
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const APPLY = args.has("--apply");
const RESET = args.has("--reset");
const SCHEDULE = args.has("--schedule");
const VERIFY = args.has("--verify");
if (!CHECK && !APPLY && !SCHEDULE && !VERIFY) {
  console.error(
    "нужен --check, --apply, --schedule или --verify (и, возможно, --reset). Смотрите шапку файла.",
  );
  process.exit(1);
}

const URL_QUERY = `https://api.supabase.com/v1/projects/${REF}/database/query`;

/**
 * Один запрос к базе.
 *
 * Токен не передаётся: прокси окружения подставляет заголовок сам. Поэтому и
 * ошибка 401 здесь означает не «неверный токен», а «секрет не настроен».
 */
async function sql(query) {
  const response = await fetch(URL_QUERY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`ответ не JSON (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok || (body && body.message)) {
    throw new Error(body?.message ?? `HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

/** Что сейчас в базе: схемы, объекты, строки. */
async function describe() {
  const objects = await sql(`
    select c.relkind::text as вид, n.nspname as схема, c.relname as имя
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'app') and c.relkind in ('r', 'v')
    order by 1, 2, 3
  `);
  const rows = await sql(`
    select coalesce(sum(n_live_tup), 0)::bigint as строк
    from pg_stat_user_tables where schemaname in ('public', 'app')
  `);
  const tables = objects.filter((o) => o.вид === "r");
  const views = objects.filter((o) => o.вид === "v");
  return { tables, views, rows: Number(rows[0]?.строк ?? 0) };
}

const before = await describe();
console.log(
  `сейчас в проекте ${REF}: таблиц ${before.tables.length}, ` +
    `представлений ${before.views.length}, строк ${before.rows}`,
);

if (CHECK && !APPLY && !SCHEDULE && !VERIFY) {
  for (const t of before.tables) console.log(`  таблица     ${t.схема}.${t.имя}`);
  for (const v of before.views) console.log(`  представление ${v.схема}.${v.имя}`);
  process.exit(0);
}

if (RESET) {
  // Схемы Supabase (auth, storage, realtime, extensions, vault) не трогаются:
  // там живёт то, что принадлежит платформе, а не нам.
  console.log("--reset: сношу схемы public и app");
  await sql(`
    drop schema if exists app cascade;
    drop schema public cascade;
    create schema public;
  `);
  // Права на public выдаёт миграция 0006, поэтому здесь ничего не выдаётся:
  // иначе продакшн получил бы права не оттуда, откуда их получают тесты.
  const after = await describe();
  console.log(
    `после сноса: таблиц ${after.tables.length}, ` +
      `представлений ${after.views.length}, строк ${after.rows}`,
  );
  if (after.tables.length > 0 || after.views.length > 0) {
    console.error("снос не довёл схему до пустой — дальше не идём");
    process.exit(1);
  }
}

// Миграции гоняются ТОЛЬКО по --apply. Без этой оговорки --verify заходил
// в прогон и падал на 0001 «тип contact_kind уже существует»: миграции не
// идемпотентны, и это не недостаток, а их устройство.
if (APPLY) {
  const dir = join(ROOT, "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  console.log(`применяю ${files.length} миграций`);

  let done = 0;
  let perStatement = 0;
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    process.stdout.write(`  ${file} … `);

    let whole;
    try {
      await sql(text);
    } catch (error) {
      whole = error;
    }

    if (whole) {
      // Запасной путь: как psql. Разбор проверен сверкой с db/rebuild.sh —
      // смотрите db/check-split.mjs.
      let statements;
      try {
        statements = split(text);
      } catch (error) {
        console.log("ОШИБКА РАЗБОРА");
        console.error(`\n${file} не разобрался на операторы: ${String(error.message)}`);
        process.exit(1);
      }
      try {
        for (const statement of statements) await sql(statement);
      } catch (error) {
        console.log("ОШИБКА");
        console.error(`\nмиграция ${file} не применилась.`);
        console.error(`одним запросом: ${String(whole.message).trim()}`);
        console.error(`пооператорно:   ${String(error.message).trim()}\n`);
        console.error(`применено до этого: ${done} из ${files.length}`);
        // Остановка на первой ошибке, а не «пропустить и дальше»: половина
        // применённых миграций — состояние, которого не бывает в тестах, и
        // отлаживать его потом будет некому.
        process.exit(1);
      }
      console.log(`ок (пооператорно, ${statements.length})`);
      perStatement += 1;
    } else {
      console.log("ок");
    }
    done += 1;
  }
  if (perStatement > 0) {
    console.log(
      `\nфайлов, которым понадобился пооператорный прогон: ${perStatement} ` +
        `(одной транзакцией они не проходят — смотрите шапку файла)`,
    );
  }
}

if (APPLY) {
  const final = await describe();
  console.log(
    `\nготово: таблиц ${final.tables.length}, представлений ${final.views.length}`,
  );
}

if (SCHEDULE) {
  // db/install_schedule.sql написан для psql и содержит его мета-команды.
  // Management API их не понимает, поэтому \set и \echo снимаются — они
  // только печатают. Любая ДРУГАЯ мета-команда означает, что файл делает
  // что-то, чего здесь не будет (например \gexec строит запросы на ходу),
  // и тогда прогон останавливается: тихо применить половину смысла хуже,
  // чем отказаться.
  const text = await readFile(join(ROOT, "db", "install_schedule.sql"), "utf8");
  const safe = /^\\(set|echo)\b/;
  const kept = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("\\")) {
      kept.push(line);
      continue;
    }
    if (safe.test(line)) continue;
    console.error(
      `db/install_schedule.sql содержит мета-команду psql, которую нельзя ` +
        `снять без потери смысла:\n  ${line.trim()}\n` +
        `Запустите файл через psql, а не через этот скрипт.`,
    );
    process.exit(1);
  }

  console.log("\nрегистрирую плановые работы");
  try {
    await sql(kept.join("\n"));
  } catch (error) {
    console.error(`расписание не установилось: ${String(error.message)}`);
    console.error(
      "если причина в pg_cron — включите расширение: Dashboard → Database → Extensions → pg_cron",
    );
    process.exit(1);
  }

  const health = await sql(
    "select job as работа, status as состояние, silence as молчание from maintenance_health_v order by job",
  );
  for (const r of health) {
    console.log(`  ${r.работа}: ${r.состояние} (молчание ${r.молчание})`);
  }
}

if (VERIFY) {
  const local = process.env.VERIFY_DB ?? "partner";
  console.log(`\nсверяю устройство с местной базой ${local}`);

  let bad = 0;
  for (const part of PARTS) {
    const query = SIGNATURE[part];

    // Пробелы сворачиваются по обеим сторонам, и это не косметика. Вывод
    // `psql -tA` разделяет записи переводом строки, а определение ограничения
    // или выражение политики сами многострочные — без сворачивания одно
    // значение разрезалось на куски, и сверка показывала «104 расхождения»
    // там, где схемы совпадают. Заодно это снимает разницу в том, как две
    // версии Postgres печатают одно и то же выражение.
    const flat = `select regexp_replace(x, '\\s+', ' ', 'g') from (${query}) t(x) order by 1`;

    const hostedRows = await sql(flat);
    const hosted = hostedRows.map((r) => Object.values(r)[0]);

    // Местная база читается psql, а не через pg: лишняя зависимость тут не
    // нужна, а вывод -tA — это ровно по строке на значение.
    const localText = execFileSync(
      "psql",
      ["-h", "/tmp", "-p", "55432", "-U", "postgres", "-d", local, "-tA",
       "-c", flat],
      { encoding: "utf8" },
    );
    const localList = localText.split("\n").filter((x) => x.length > 0);

    const onlyLocal = localList.filter((x) => !hosted.includes(x));
    const onlyHosted = hosted.filter((x) => !localList.includes(x));
    const mark = onlyLocal.length + onlyHosted.length === 0 ? "ок" : "РАСХОЖДЕНИЕ";
    console.log(`  ${part}: местно ${localList.length}, размещено ${hosted.length} — ${mark}`);
    for (const x of onlyLocal.slice(0, 5)) console.log(`      только местно:   ${x.slice(0, 160)}`);
    for (const x of onlyHosted.slice(0, 5)) console.log(`      только размещено: ${x.slice(0, 160)}`);
    bad += onlyLocal.length + onlyHosted.length;
  }

  if (bad > 0) {
    console.error(
      `\nустройство разошлось в ${bad} местах: размещённая база — НЕ та, ` +
        `на которой проходят тесты`,
    );
    process.exit(1);
  }
  console.log("\nустройство совпало: размещённая база та же, что проверяют тесты");
}
