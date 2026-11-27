/**
 * Курс Нацбанка: разбор ответа и пересчёт цен.
 *
 * Без 'server-only' намеренно: разбор — чистая функция, и проверять её
 * надо без сети и без базы. Обращений ни к тому, ни к другому здесь нет.
 *
 * Что на самом деле отдаёт www.nbkr.kg/XML/daily.xml — прочитано, а не
 * вспомнено:
 *
 *     <?xml version="1.0" encoding="windows-1251" ?>
 *     <CurrencyRates Name="Daily Exchange Rates" Date="28.11.2026">
 *     <Currency ISOCode="USD"><Nominal>1</Nominal><Value>87,4500</Value></Currency>
 *
 * Три вещи, каждая из которых ломает разбор молча:
 *
 * 1. РАЗДЕЛИТЕЛЬ — ЗАПЯТАЯ. `parseFloat('87,4500')` возвращает 87, без
 *    ошибки. Курс занижается в сто раз, цены в сомах выходят втрое
 *    меньше правды, и заметить это можно только глазами.
 * 2. Дата в виде ДД.ММ.ГГГГ. `new Date('28.11.2026')` в V8 даёт
 *    Invalid Date; собираем ISO сами.
 * 3. Nominal бывает не единицей (у валют с мелким номиналом), и значение
 *    относится к Nominal единицам, а не к одной.
 */

export type FxRate = { code: string; somPerUnit: number };
export type FxSnapshot = { asOf: string; rates: FxRate[] };

/** Число из ответа Нацбанка: «87,4500» → 87.45. */
function value(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** «28.11.2026» → «2026-11-28». Пусто, если формат не тот. */
function isoDate(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Разбор ответа Нацбанка.
 *
 * Регулярными выражениями, а не разборщиком XML: в Worker'е нет DOMParser,
 * а тянуть библиотеку ради документа в пятьсот байт — несоразмерно.
 * Документ простой и его форма зафиксирована проверками.
 *
 * Пустой ответ означает «разобрать не вышло» — вызывающий обязан оставить
 * прежний курс, а не записать ноль.
 */
export function parseNbkr(xml: string): FxSnapshot | null {
  const head = /<CurrencyRates[^>]*\sDate="([^"]+)"/.exec(xml);
  const asOf = head ? isoDate(head[1]!) : null;
  if (!asOf) return null;

  const rates: FxRate[] = [];
  const entry =
    /<Currency\s+ISOCode="([A-Z]{3})"\s*>\s*<Nominal>\s*([\d.,]+)\s*<\/Nominal>\s*<Value>\s*([\d.,]+)\s*<\/Value>/g;

  for (const m of xml.matchAll(entry)) {
    const nominal = value(m[2]!);
    const per = value(m[3]!);
    // Значение относится к Nominal единицам: делим, чтобы получить цену
    // одной. Для доллара Nominal равен единице, но полагаться на это
    // нельзя — у валют с мелким номиналом он другой.
    if (nominal && per) rates.push({ code: m[1]!, somPerUnit: per / nominal });
  }

  return rates.length > 0 ? { asOf, rates } : null;
}

/** Валюты, между которыми умеем пересчитывать. */
export type Money = 'USD' | 'KGS';

export function isMoney(v: string | null | undefined): v is Money {
  return v === 'USD' || v === 'KGS';
}

/**
 * Пересчёт суммы из одной валюты в другую по курсу «сомов за доллар».
 *
 * Возвращает null, когда пересчитать нечем или незачем — вызывающий
 * показывает цену как есть. Выдуманного курса здесь нет и быть не может:
 * цена в чужой валюте без курса — это не «примерно столько», а неправда.
 */
export function convert(
  amount: number,
  from: string,
  to: Money,
  somPerUsd: number | null,
): number | null {
  if (from === to) return amount;
  if (!somPerUsd || somPerUsd <= 0) return null;
  if (from === 'USD' && to === 'KGS') return amount * somPerUsd;
  if (from === 'KGS' && to === 'USD') return amount / somPerUsd;
  // Третья валюта: курса к ней у нас нет, и придумывать его нельзя.
  return null;
}
