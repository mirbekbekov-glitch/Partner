'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * Код причины, а не готовая фраза: язык страницы знает форма, а не сервер.
 */
export type RequestError = 'BAD_PHONE' | 'BAD_INPUT' | 'TOO_MANY' | 'OTHER';
export type RequestResult = { ok: boolean; code: RequestError | null };

/**
 * Приём заявки «что я ищу» с публичной страницы.
 *
 * Здесь ничего не решается: всё проверяет submit_request() в базе. Форму
 * обойти тривиально — запрос уходит прямо в PostgREST, — и проверка,
 * живущая только в этом файле, не значила бы ничего.
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
  // Приманка для ботов: поле скрыто от человека, но живо в разметке.
  // Заполнено — значит заполнял не человек. Отвечаем как при успехе,
  // чтобы бот не знал, по какому признаку его отличили.
  if (String(formData.get('website') ?? '').trim() !== '') {
    return { ok: true, code: null };
  }

  const str = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v === '' ? null : v;
  };
  const num = (k: string) => {
    const v = Number.parseInt(String(formData.get(k) ?? ''), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  const source = str('source');

  const supabase = await createClient();
  const { error } = await supabase.rpc('submit_request', {
    p_phone: String(formData.get('phone') ?? ''),
    p_name: str('name'),
    p_deal: str('deal'),
    p_housing_type: str('housing_type'),
    p_rooms: num('rooms'),
    p_district: str('district'),
    p_budget: num('budget'),
    p_budget_currency: str('budget_currency') ?? 'USD',
    p_wishes: str('wishes'),
    p_consent: formData.get('consent') === 'on',
    // Метка источника добавляется, только когда форма её прислала.
    //
    // Это не украшение, а защита от порядка выкладки. PostgREST выбирает
    // функцию по именам переданных параметров: пока миграция 0032 не
    // применена, в базе лежит прежняя подпись без p_source, и запрос с
    // лишним параметром упал бы. Формы без метки — то есть все прежние —
    // продолжают работать при любом порядке событий.
    ...(source === null ? {} : { p_source: source }),
  });

  if (!error) return { ok: true, code: null };

  const m = error.message ?? '';
  for (const code of ['BAD_PHONE', 'BAD_INPUT', 'TOO_MANY'] as const) {
    if (m.includes(code)) return { ok: false, code };
  }
  return { ok: false, code: 'OTHER' };
}
