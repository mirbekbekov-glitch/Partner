'use server';

import { createClient } from '@/lib/supabase/server';

export type LeadResult = { ok: boolean; error: string | null };

/**
 * Приём заявки с публичной страницы объекта.
 *
 * Сюда заявка приходит от анонима, поэтому здесь ничего не решается: всё
 * проверяет submit_lead() в базе. Форму обойти тривиально — запрос уходит
 * прямо в PostgREST, — и проверка, живущая только в этом файле, не значила
 * бы ничего.
 *
 * Задача этого кода — превратить код ошибки в человеческую фразу.
 */
export async function submitLead(formData: FormData): Promise<LeadResult> {
  // Приманка для ботов: поле скрыто от человека, но живо в разметке.
  // Заполнено — значит заполнял не человек. Отвечаем как при успехе,
  // чтобы бот не знал, по какому признаку его отличили.
  if (String(formData.get('website') ?? '').trim() !== '') {
    return { ok: true, error: null };
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

  if (!error) return { ok: true, error: null };

  const m = error.message ?? '';
  if (m.includes('BAD_PHONE')) {
    return { ok: false, error: 'Проверьте номер телефона: по нему с вами свяжутся.' };
  }
  if (m.includes('BAD_INPUT')) {
    return { ok: false, error: 'Проверьте имя и текст сообщения.' };
  }
  if (m.includes('TOO_MANY')) {
    return { ok: false, error: 'Заявок с этого номера сейчас слишком много. Попробуйте через час.' };
  }
  if (m.includes('NOT_FOUND')) {
    return { ok: false, error: 'Этот объект больше не в продаже.' };
  }
  return { ok: false, error: 'Не удалось отправить заявку. Попробуйте ещё раз.' };
}
