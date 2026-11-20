import { Pool, type PoolClient } from "pg";

/**
 * Доступ к базе каталога.
 *
 * Каталог читает базу под ролью `anon` — той же, которой выданы права в
 * `0006_rls.sql`. Это сделано не ради красоты: роль и есть защита. Даже если
 * запрос здесь написан неправильно, он физически не достанет ни контактов, ни
 * комиссии, ни неопубликованного объекта, потому что `anon` на них прав не
 * имеет, а построчные политики отдают только `publication_state = 'published'`.
 *
 * Проверка в коде страницы защищала бы только страницу. Проверка в базе
 * защищает всё, что к базе обращается.
 */

const connectionString = process.env.DATABASE_URL;
const role = process.env.CATALOG_DB_ROLE ?? "anon";

if (!connectionString) {
  throw new Error(
    "DATABASE_URL не задан. Смотрите web/.env.example: каталогу нужна строка подключения к базе.",
  );
}

// Имя роли подставляется в SQL, параметром его передать нельзя. Поэтому оно
// проверяется здесь, а не доверяется переменной окружения на слово.
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  throw new Error(`CATALOG_DB_ROLE содержит недопустимое имя роли: ${role}`);
}

declare global {
  // В dev-режиме Next перезагружает модули, и без этого пул протекал бы
  // новым соединением на каждую правку файла.
  var __catalogPool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__catalogPool) {
    globalThis.__catalogPool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Каталог только читает: долгий запрос означает ошибку, а не работу.
      statement_timeout: 5_000,
    });
  }
  return globalThis.__catalogPool;
}

/**
 * Выполняет запросы в транзакции, понизив права до роли каталога.
 * `set local` действует до конца транзакции, поэтому роль не утекает в
 * следующий запрос по тому же соединению из пула.
 */
export async function asCatalogRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin read only");
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
