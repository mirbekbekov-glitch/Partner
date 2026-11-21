'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * Код причины, а не готовая фраза: язык страницы знает форма, а не сервер.
 * Иначе заявку на китайской версии завернуло бы русским текстом.
 */
export type LeadError = 'BAD_PHONE' | 'BAD_INPUT' | 'TOO_MANY' | 'NOT_FOUND' | 'OTHER';
export type LeadResult = { ok: boolean; code: LeadError | null };

/**
 * Приём заявки с публичной страницы объекта.
 *
 * Сюда заявка приходит от анонима, поэтому здесь ничего не решается: всё
 * проверяет submit_lead() в базе. Форму обойти тривиально — запрос уходит
 * прямо в PostgREST, — и проверка, живущая только в этом файле, не значила
 * бы ничего.
 *
 * Задача этого кода — свести ответ базы к одному из известных кодов.
 *
 * Подпись с первым аргументом — требование useActionState. Благодаря ей
 * форма уходит POST-ом и без JavaScript: иначе браузер отправлял бы её
 * обычным GET, и телефон человека попадал бы в адресную строку.
 */
export async function submitLead(
  _prev: LeadResult | null,
  formData: FormData,
): Promise<LeadResult> {
  // Приманка для ботов: поле скрыто от человека, но живо в разметке.
  // Заполнено — значит заполнял не человек. Отвечаем как при успехе,
  // чтобы бот не знал, по какому признаку его отличили.
  if (String(formData.get('website') ?? '').trim() !== '') {
    return { ok: true, code: null };
  }

  const objectId = String(formData.get('object_id') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').trim();
  const message = String(formData.get('message') ?? '').trim();

  const supabase = await createClient();
  const { error } = await supabase.rpc('submit_lead', {
    p_object_id: objectId,
    p_name: name,
    p_phone: phone,
    p_message: message === '' ? null : message,
  });

  if (!error) return { ok: true, code: null };

  const m = error.message ?? '';
  for (const code of ['BAD_PHONE', 'BAD_INPUT', 'TOO_MANY', 'NOT_FOUND'] as const) {
    if (m.includes(code)) return { ok: false, code };
  }
  return { ok: false, code: 'OTHER' };
}
