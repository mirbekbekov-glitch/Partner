/**
 * Применение схемы к боевой базе D1.
 *
 * Запускается шагом выкладки, после того как Worker выложен и база
 * заведена. Ходит в REST API Cloudflare напрямую, а не через CLI: те же
 * два запроса уже проверены в выкладке диагностическим шагом, и здесь у
 * них нет ни скрытых флагов, ни догадок об имени команды.
 *
 * Применяется при КАЖДОЙ выкладке, а не один раз. Все команды схемы
 * написаны через IF NOT EXISTS, поэтому повторный прогон ничего не меняет
 * и ничего не роняет. Отдельный «накат один раз» потребовал бы хранить
 * где-то отметку о применении — лишняя сущность ради того же результата.
 *
 * Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID.
 */
import { statementsOfFile } from './statements.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DATABASE = 'partner';
const here = dirname(fileURLToPath(import.meta.url));

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !account) {
  console.error('Нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID.');
  process.exit(1);
}

const api = 'https://api.cloudflare.com/client/v4';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

/** Ответ Cloudflare или внятная ошибка. Коды и сообщения — не секреты. */
async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers });
  const body = await response.json();

  if (!body.success) {
    const why = (body.errors ?? []).map((e) => `[${e.code}] ${e.message}`).join('; ');
    throw new Error(`${path} → ${response.status}: ${why || 'без объяснения'}`);
  }
  return body.result;
}

// 1. Найти базу по имени. Идентификатор в репозитории не хранится: он
//    привязал бы код к одному аккаунту.
const found = await call(
  `/accounts/${account}/d1/database?name=${encodeURIComponent(DATABASE)}`,
);
const database = (found ?? []).find((d) => d.name === DATABASE);

if (!database) {
  console.error(
    `Базы «${DATABASE}» нет. Её заводит выкладка по привязке в `
    + 'cloudflare.config.ts — значит, выкладка ещё не проходила.',
  );
  process.exit(1);
}

// 2. Применить схему.
// PRAGMA через REST API не проходит: D1 управляет настройками соединения
// сама и чужих не принимает. Внешние ключи у неё и так включены — строка в
// схеме стоит ради локального прогона, где база поднимается напрямую.
const statements = statementsOfFile(resolve(here, '0001_schema.sql'))
  .filter((sql) => !/^pragma\b/i.test(sql));
console.log(`База ${DATABASE}: применяю ${statements.length} команд.`);

let applied = 0;
for (const sql of statements) {
  try {
    await call(`/accounts/${account}/d1/database/${database.uuid}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
    applied++;
  } catch (e) {
    // Имя команды в сообщении помогает понять, на чём встало, а текста
    // данных здесь нет вовсе — только DDL.
    console.error(`Не применилось: ${sql.slice(0, 80)}…`);
    throw e;
  }
}

// 3. Сказать, что получилось, — чтобы по логу было видно состояние базы,
//    а не только «шаг прошёл».
const tables = await call(
  `/accounts/${account}/d1/database/${database.uuid}/query`,
  {
    method: 'POST',
    body: JSON.stringify({
      sql: `select name from sqlite_master where type = 'table'
             and name not like 'sqlite_%' order by name`,
    }),
  },
);

const names = (tables?.[0]?.results ?? []).map((r) => r.name);
console.log(`Применено команд: ${applied}.`);
console.log(`Таблиц в базе: ${names.length} — ${names.join(', ')}`);
