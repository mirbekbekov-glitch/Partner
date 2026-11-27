import 'server-only';
import { all, now, one, run } from './sql';
import { parseNbkr } from '../fx';

/**
 * Хранение курса и его обновление у Нацбанка.
 *
 * Читается витриной — курс не секрет, он стоит на странице рядом с ценой,
 * и прятать его не от кого.
 */

const NBKR = 'https://www.nbkr.kg/XML/daily.xml';

export type StoredRate = { code: string; som_per_unit: number; as_of: string };

/** Курс доллара: сколько сомов за один. Пусто — пересчитывать нечем. */
export async function usdRate(): Promise<StoredRate | null> {
  return one<StoredRate>(
    `select code, som_per_unit, as_of from fx_rates where code = 'USD'`,
  );
}

/** Все известные курсы — для админского экрана. */
export async function knownRates(): Promise<Array<StoredRate & { fetched_at: string }>> {
  return all<StoredRate & { fetched_at: string }>(
    'select code, som_per_unit, as_of, fetched_at from fx_rates order by code',
  );
}

/**
 * Забрать курс у Нацбанка и записать.
 *
 * Возвращает число записанных валют. Ноль означает «не вышло» — и это
 * НЕ ошибка, которую надо выбросить наверх: прежний курс остаётся в базе
 * и продолжает работать. Нацбанк недоступен несколько часов — сайт
 * показывает вчерашний курс с его датой, а не ломается и не выдумывает.
 *
 * Ответ приходит с заголовком windows-1251, но всё его содержимое —
 * латиница, цифры и знаки препинания, то есть ASCII. Поэтому читаем
 * текстом как есть: перекодировать нечего, а добавлять декодер ради
 * заголовка значило бы тащить зависимость впустую. Если Нацбанк однажды
 * добавит в документ кириллицу, разбор от этого не пострадает —
 * регулярные выражения смотрят только на коды валют и числа.
 */
export async function refreshRates(): Promise<number> {
  let xml: string;

  try {
    const response = await fetch(NBKR, { headers: { accept: 'application/xml' } });
    if (!response.ok) return 0;
    xml = await response.text();
  } catch {
    return 0;
  }

  const snapshot = parseNbkr(xml);
  if (!snapshot) return 0;

  const at = now();
  let written = 0;

  for (const rate of snapshot.rates) {
    // insert or replace, а не update: первая запись заводит строку, все
    // последующие её переписывают, и отдельной ветки «а есть ли уже»
    // не нужно.
    await run(
      `insert or replace into fx_rates (code, som_per_unit, as_of, fetched_at)
       values (?, ?, ?, ?)`,
      rate.code, rate.somPerUnit, snapshot.asOf, at,
    );
    written += 1;
  }

  return written;
}
