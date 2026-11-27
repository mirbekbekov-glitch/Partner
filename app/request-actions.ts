'use server';

import { submitRequest as acceptRequest } from '@/lib/db/requests';
import { BudgetTooLow, Invalid } from '@/lib/db/errors';
import { toMinor } from '@/lib/db/money';

/**
 * Код причины, а не готовая фраза: язык страницы знает форма, а не сервер.
 */
export type RequestError = 'BAD_PHONE' | 'BAD_INPUT' | 'TOO_MANY' | 'LOW_BUDGET' | 'OTHER';

/**
 * Ответ формы.
 *
 * `floor` заполняется только у LOW_BUDGET: форме нужны ЧИСЛА — порог,
 * валюта и число объявлений, — чтобы сказать человеку, сколько стоит
 * искомое, и предложить подставить. Разбирать их из фразы значило бы
 * писать разборщик собственных сообщений, который сломается на первом же
 * переводе.
 */
export type RequestResult = {
  ok: boolean;
  code: RequestError | null;
  floor?: { amount: number; currency: string; basedOn: number };
};

/**
 * Приём заявки с публичной страницы — и «что я ищу», и «что я отдаю».
 *
 * Здесь ничего не решается: все проверки живут в слое доступа
 * (lib/db/requests.ts) — границы полей, нормализация телефона, склейка
 * повторов, частота. Форма это удобство, а не защита, и проверка, живущая
 * только в этом файле, не значила бы ничего.
 *
 * Подпись с первым аргументом — требование useActionState. Благодаря ей
 * форма отправляется как POST и БЕЗ JavaScript: раньше при неудачной
 * загрузке скриптов браузер отправлял её обычным GET, и телефон человека
 * уезжал в адресную строку, в историю браузера и в журналы сервера.
 */
export async function submitRequest(
  _prev: RequestResult | null,
  formData: FormData,
): Promise<RequestResult> {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? null : v;
  };
  const num = (k: string) => {
    const v = Number.parseInt(String(formData.get(k) ?? ''), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  try {
    await acceptRequest({
      phone: String(formData.get('phone') ?? ''),
      name: str('name'),
      deal: str('deal'),
      // Сторона заявки. Отдельного поля «сторона» в базе нет: заполненный
      // offer_deal и означает, что заявку оставил собственник.
      offer_deal: str('offer_deal'),
      address: str('address'),
      // Подробный тип. housing_type слой доступа выводит из него сам —
      // два поля из формы разошлись бы, и заявка на кабинет приехала бы
      // заявкой на квартиру.
      space_type: str('space_type'),
      term_days_min: num('term_days_min'),
      term_days_max: num('term_days_max'),
      rooms: num('rooms'),
      district: str('district'),
      // Человек вводит бюджет в долларах или сомах, а в базе деньги целые
      // и минорные — перевод здесь, на границе формы.
      budget_minor: toMinor(str('budget')),
      budget_currency: str('budget_currency') ?? 'USD',
      wishes: str('wishes'),
      consent: formData.get('consent') === 'on',
      source: str('source'),
      // Приманка для ботов: поле скрыто от человека, но живо в разметке.
      // Заполнено — значит заполнял не человек. Слой доступа ответит как
      // при успехе, чтобы бот не знал, по какому признаку его отличили.
      trap: String(formData.get('website') ?? ''),
    });
    return { ok: true, code: null };
  } catch (e) {
    // По ТИПУ ошибки, а не по тексту: тип переживает перевод, текст нет.
    // Остальные ветки ниже всё ещё опознаются по фразе — это наследство,
    // и трогать его заодно значило бы менять то, о чём не просили.
    if (e instanceof BudgetTooLow) {
      return {
        ok: false,
        code: 'LOW_BUDGET',
        floor: { amount: e.floor, currency: e.currency, basedOn: e.basedOn },
      };
    }

    if (e instanceof Invalid) {
      const text = e.message;
      if (text.includes('номер телефона')) return { ok: false, code: 'BAD_PHONE' };
      if (text.includes('Слишком много')) return { ok: false, code: 'TOO_MANY' };
      return { ok: false, code: 'BAD_INPUT' };
    }
    return { ok: false, code: 'OTHER' };
  }
}
