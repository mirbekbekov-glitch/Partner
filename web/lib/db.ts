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

/**
 * Часовой пояс агентства.
 *
 * Пока в кабинете были только даты, это ничего не стоило. Экран показов
 * вскрыл цену: контейнер живёт в UTC, и «показ в 15:00», введённый агентом,
 * превращался в 15:00 UTC — то есть в 21:00 по Бишкеку. На экране он снова
 * рисовался как 15:00, потому что обратное преобразование ошибалось на те же
 * шесть часов, и ошибка была незаметна ровно до первого вопроса «сегодня или
 * завтра»: показ в 20:00 по Бишкеку попадал в завтрашний список.
 *
 * Поэтому пояс задаётся на соединении, а не угадывается: и приведение
 * введённого времени к timestamptz, и сравнения с now(), и группировка по
 * дням считаются по Бишкеку. Представления базы при этом пишут пояс явно —
 * они не должны зависеть от того, кто их читает.
 */
const TZ = "Asia/Bishkek";

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

async function inTransaction<T>(
  mode: "read only" | "read write",
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query(`begin ${mode}`);
    await client.query(`set local time zone '${TZ}'`);
    // `set local` действует до конца транзакции, поэтому роль не утекает в
    // следующий запрос по тому же соединению из пула.
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

/** Чтение каталога: права понижены, запись невозможна даже случайно. */
export async function asCatalogRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction("read only", fn);
}

/**
 * Отчёт собственнику. Права понижены так же, но транзакция пишущая: функция
 * `app.owner_report()` считает просмотры, а агенту важно знать, дошла ли
 * ссылка. Больше роли `anon` ничего не позволено: прав на таблицы у неё нет,
 * поэтому пишущая транзакция ничего не открывает сама по себе.
 */
export async function asReportRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction("read write", fn);
}

/**
 * Служба входа. Отдельная роль `auth_service` (инвариант 18): ей открыты
 * только выдача кода, его проверка и сам вход. Каталог этих функций не
 * вызывает — иначе любой желающий получал бы код входа для чужого номера
 * прямо в ответе.
 */
export async function asAuthService<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole(process.env.AUTH_DB_ROLE ?? "auth_service", "read write", null, fn);
}

/**
 * Кабинет агента. Роль `authenticated` и клеймы входа — тот же путь, которым
 * ходит Supabase: `auth.uid()` читает `sub` из `request.jwt.claims`.
 *
 * Клеймы выставляются `set_config(..., true)`, то есть до конца транзакции.
 * Поэтому они не утекают в следующий запрос по тому же соединению из пула —
 * иначе один агент увидел бы данные другого, и никакая RLS не помогла бы.
 */
export async function asAgent<T>(
  claims: { sub: string; email: string },
  mode: "read only" | "read write",
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole(
    process.env.CABINET_DB_ROLE ?? "authenticated",
    mode,
    JSON.stringify({ ...claims, role: "authenticated" }),
    fn,
  );
}

/**
 * Отправщик уведомлений. Отдельная роль `notifier` (инвариант 27): ей открыты
 * три функции — взять пачку, отметить отправленным, отметить неудачей — и ни
 * одной таблицы. Процесс, умеющий только отправлять, при утечке токена и
 * может только отправлять: ни клиентов, ни сделок он не прочитает.
 */
export async function asNotifier<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole(process.env.NOTIFY_DB_ROLE ?? "notifier", "read write", null, fn);
}

async function withRole<T>(
  roleName: string,
  mode: "read only" | "read write",
  claims: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) {
    throw new Error(`недопустимое имя роли: ${roleName}`);
  }
  const client = await pool().connect();
  try {
    await client.query(`begin ${mode}`);
    await client.query(`set local time zone '${TZ}'`);
    if (claims !== null) {
      // Клеймы идут параметром, а не в текст запроса: там номер телефона и
      // идентификатор человека.
      await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    }
    await client.query(`set local role ${roleName}`);
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
