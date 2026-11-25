import 'server-only';
import { env } from 'cloudflare:workers';

/**
 * Доступ к D1 и общие помощники запросов.
 *
 * Весь проект ходит в базу ТОЛЬКО отсюда. Это не стилистическое правило:
 * нормализация телефонов, журнал действий и проверки инвариантов живут в
 * коде, и запись мимо этого слоя их обойдёт. В Postgres от такого защищала
 * сама база; здесь защищает то, что другого пути к привязке нет.
 */

/** Привязка базы. Имя совпадает с cloudflare.config.ts. */
export function db(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) {
    throw new Error(
      'Нет привязки D1 «DB». Она описана в cloudflare.config.ts и создаётся '
      + 'командой npx cf d1 create.',
    );
  }
  return binding;
}

/** Время в том виде, в каком оно лежит в базе: ISO-8601, UTC, с миллисекундами. */
export function now(): string {
  return new Date().toISOString();
}

/** Момент через заданное число миллисекунд от текущего. */
export function from_now(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Новый идентификатор записи. UUID v4, как было в Postgres. */
export function newId(): string {
  return crypto.randomUUID();
}

/** Значения, которые D1 принимает в параметрах запроса. */
export type Param = string | number | null;

/** Одна строка или ничего. */
export async function one<T>(sql: string, ...params: Param[]): Promise<T | null> {
  return (await db().prepare(sql).bind(...params).first<T>()) ?? null;
}

/** Все строки. */
export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  const r = await db().prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

/** Запрос без чтения. Возвращает число затронутых строк. */
export async function run(sql: string, ...params: Param[]): Promise<number> {
  const r = await db().prepare(sql).bind(...params).run();
  return r.meta?.changes ?? 0;
}

/** Готовый запрос для батча. */
export function stmt(sql: string, ...params: Param[]): D1PreparedStatement {
  return db().prepare(sql).bind(...params);
}

/**
 * Несколько запросов одной транзакцией.
 *
 * D1 выполняет батч как транзакцию: либо все, либо ни один. Это
 * единственный способ получить здесь атомарность — BEGIN/COMMIT вручную D1
 * не принимает. Поэтому всё, что в Postgres держал один триггер, здесь
 * обязано ехать одним батчем.
 */
export async function batch(statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await db().batch(statements);
}

/** Логическое значение из базы: SQLite хранит 0 и 1. */
export function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

/** Логическое значение в базу. */
export function flag(value: boolean): number {
  return value ? 1 : 0;
}

/** JSON-колонка → массив. Битое значение не роняет страницу: это данные. */
export function jsonArray<T>(text: string | null | undefined): T[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Массив → JSON-колонка. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

/**
 * Список «?, ?, ?» нужной длины.
 *
 * Подставлять значения в текст запроса нельзя даже «свои»: ровно так
 * появляются внедрения SQL. Параметры передаются отдельно всегда.
 */
export function holders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
