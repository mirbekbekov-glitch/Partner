/**
 * Комиссия — инвариант 3.
 *
 * База: продажа 2% цены, аренда 50% первого месяца. Правило мандата
 * (commission_rule) переопределяет базу — данными, а не кодом.
 *
 * Делим 50/50. Остаток от деления отдаётся listing-агенту, чтобы две доли
 * всегда складывались ровно в итог: при нечётной сумме половинки иначе
 * дадут на одну минорную единицу меньше, и в отчёте не сойдётся.
 *
 * Всё в минорных единицах и в целых числах. Это и есть причина, по которой
 * деньги хранятся целыми: тут делят пополам, и терять копейку нельзя.
 */

export type DealType = 'rent' | 'sale';

/** Правило из мандата. Неполное или неизвестное — работает база. */
export type CommissionRule =
  | { kind: 'percent'; value: number }       // процент цены
  | { kind: 'months_share'; value: number }  // доля месячной платы
  | { kind: 'fixed'; value: number }         // фиксированная сумма, в основных единицах
  | null;

/** Доля, которая достаётся closing-агенту. Половина. */
const CLOSING_RATIO = 0.5;

/** Итог комиссии в минорных единицах. */
export function commissionTotal(
  dealType: DealType,
  priceMinor: number | null,
  rule: CommissionRule = null,
): number | null {
  if (priceMinor === null || priceMinor <= 0) return null;

  const base = () =>
    Math.round(priceMinor * (dealType === 'sale' ? 0.02 : 0.5));

  if (!rule || typeof rule.value !== 'number' || !Number.isFinite(rule.value)) {
    return base();
  }

  switch (rule.kind) {
    case 'percent':      return Math.round(priceMinor * rule.value / 100);
    case 'months_share': return Math.round(priceMinor * rule.value);
    // Фиксированную сумму задают в основных единицах: в договоре пишут
    // «1000 $», а не «100000».
    case 'fixed':        return Math.round(rule.value * 100);
    default:             return base();
  }
}

/** Доли сторон. Складываются ровно в итог — это проверяется тестом. */
export function commissionShares(totalMinor: number | null): {
  listing: number | null;
  closing: number | null;
} {
  if (totalMinor === null) return { listing: null, closing: null };

  const closing = Math.round(totalMinor * CLOSING_RATIO);
  return { listing: totalMinor - closing, closing };
}

/** Разбор commission_rule из колонки. Мусор в колонке означает «базовое правило». */
export function parseRule(text: string | null | undefined): CommissionRule {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { kind?: string; value?: number };
    if (!parsed || typeof parsed.value !== 'number') return null;
    if (parsed.kind === 'percent' || parsed.kind === 'months_share'
        || parsed.kind === 'fixed') {
      return { kind: parsed.kind, value: parsed.value };
    }
    return null;
  } catch {
    return null;
  }
}
