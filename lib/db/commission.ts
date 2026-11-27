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

/**
 * Доля closing-агента, когда процент партнёра не назван, в процентах
 * от комиссии.
 *
 * Половина — обычай рынка: тот, кто привёл покупателя, сделал половину
 * работы. Это именно УМОЛЧАНИЕ для старых объектов: в карточке условие
 * теперь называют процентом от сделки, и тогда работает он.
 */
export const PARTNER_SHARE_DEFAULT = 50;

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

/**
 * Сколько обещано партнёру.
 *
 * Процент НЕ от нашей комиссии, а от сделки: от цены при продаже, от
 * месячной платы при аренде (у аренды цена и есть месячная плата). Так
 * это условие называют на рынке — «отдаю процент с продажи», «отдаю
 * столько-то процентов месяца», — и так его называет агент в карточке.
 */
export function partnerAmount(
  priceMinor: number | null,
  rate: number | null | undefined,
): number | null {
  if (priceMinor === null || priceMinor <= 0) return null;
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  if (rate < 0 || rate > 100) return null;
  return Math.round(priceMinor * rate / 100);
}

/**
 * Итог и доли сторон.
 *
 * Названный процент партнёра И ЕСТЬ доля closing-агента: это обещание,
 * данное в карточке, и пересчитывать его нам нечем. Остальное достаётся
 * listing-агенту.
 *
 * Обещано больше, чем наша комиссия, — итогом считается обещанное:
 * агентство не может получить меньше, чем должно отдать, а отрицательная
 * доля прятала бы ошибку в условиях за арифметикой. Ведущий агент видит
 * у себя ноль и понимает, что назначил партнёру больше, чем берёт сам.
 *
 * Процент не назван — прежнее правило: пополам. Остаток от деления
 * достаётся listing-агенту, чтобы две доли давали ровно итог.
 */
export function commissionShares(
  totalMinor: number | null,
  partner?: { priceMinor: number | null; rate: number | null } | null,
): { listing: number | null; closing: number | null; total: number | null } {
  if (totalMinor === null) return { listing: null, closing: null, total: null };

  const promised = partner ? partnerAmount(partner.priceMinor, partner.rate) : null;

  if (promised === null) {
    const closing = Math.round(totalMinor * PARTNER_SHARE_DEFAULT / 100);
    return { listing: totalMinor - closing, closing, total: totalMinor };
  }

  const total = Math.max(totalMinor, promised);
  return { listing: total - promised, closing: promised, total };
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
