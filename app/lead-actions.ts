'use server';

import { submitLead as acceptLead } from '@/lib/db/leads';
import { Invalid, NotFound } from '@/lib/db/errors';

/**
 * Код причины, а не готовая фраза: язык страницы знает форма, а не сервер.
 * Иначе заявку на китайской версии завернуло бы русским текстом.
 */
export type LeadError = 'BAD_PHONE' | 'BAD_INPUT' | 'TOO_MANY' | 'NOT_FOUND' | 'OTHER';
export type LeadResult = { ok: boolean; code: LeadError | null };

/**
 * Приём заявки с публичной страницы объекта.
 *
 * Сюда заявка приходит от анонима, поэтому здесь ничего не решается: все
 * проверки живут в слое доступа (lib/db/leads.ts) — опубликован ли объект,
 * границы полей, нормализация телефона, повторы и частота.
 *
 * Раньше это объяснялось тем, что форму обойти тривиально: запрос уходил
 * прямо в PostgREST. Теперь до базы мимо Worker не добраться вовсе, но
 * правило осталось прежним — проверять на сервере, потому что форма это
 * удобство, а не защита.
 *
 * Задача этого кода — свести ответ слоя доступа к одному из известных
 * кодов.
 *
 * Подпись с первым аргументом — требование useActionState. Благодаря ей
 * форма уходит POST-ом и без JavaScript: иначе браузер отправлял бы её
 * обычным GET, и телефон человека попадал бы в адресную строку.
 */
export async function submitLead(
  _prev: LeadResult | null,
  formData: FormData,
): Promise<LeadResult> {
  const objectId = String(formData.get('object_id') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').trim();
  const message = String(formData.get('message') ?? '').trim();

  try {
    await acceptLead({
      object_id: objectId,
      name,
      phone,
      message: message === '' ? null : message,
      // Приманка для ботов: поле скрыто от человека, но живо в разметке.
      // Заполнено — значит заполнял не человек. Слой доступа ответит как
      // при успехе, чтобы бот не знал, по какому признаку его отличили.
      trap: String(formData.get('website') ?? ''),
    });
    return { ok: true, code: null };
  } catch (e) {
    // Коды, а не тексты: язык страницы знает форма, а не сервер.
    if (e instanceof NotFound) return { ok: false, code: 'NOT_FOUND' };

    if (e instanceof Invalid) {
      const text = e.message;
      if (text.includes('Телефон')) return { ok: false, code: 'BAD_PHONE' };
      if (text.includes('Слишком много')) return { ok: false, code: 'TOO_MANY' };
      return { ok: false, code: 'BAD_INPUT' };
    }

    return { ok: false, code: 'OTHER' };
  }
}
