/**
 * Деньги — целые в минорных единицах.
 *
 * В Postgres было numeric(14,2), в SQLite такого типа нет, а REAL для денег
 * не годится: 0.1 + 0.2 в нём не равно 0.3, а комиссия делится пополам и
 * сравнивается с бюджетом. Поэтому в базе лежат целые: 550 000 $ это
 * 55 000 000. Колонки называются *_minor, чтобы никто не записал туда
 * доллары.
 *
 * Деления здесь нет совсем: доли комиссии считает commission.ts, и остаток
 * от деления он не теряет.
 */

/** Сколько минорных единиц в одной основной. Для USD и KGS — 100. */
export const MINOR = 100;

/** Введённое человеком («550000», «550 000,50») → минорные единицы. */
export function toMinor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole, frac = ''] = text.split('.');
  // Дробная часть дополняется справа, а не слева: «1.5» это 1.50, не 1.05.
  return Number(whole) * MINOR + Number(frac.padEnd(2, '0'));
}

/** Минорные единицы → число для показа. */
export function fromMinor(minor: number | null | undefined): number | null {
  if (minor === null || minor === undefined) return null;
  return minor / MINOR;
}

/** Минорные единицы → строка для глаз: «550 000» или «1 250,50». */
export function formatMinor(
  minor: number | null | undefined,
  currency?: string | null,
): string {
  if (minor === null || minor === undefined) return '';

  const whole = Math.trunc(minor / MINOR);
  const frac = Math.abs(minor % MINOR);
  const text = whole.toLocaleString('ru-RU')
    + (frac ? ',' + String(frac).padStart(2, '0') : '');

  return currency ? `${text} ${currency}` : text;
}
