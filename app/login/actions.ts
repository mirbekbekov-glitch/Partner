'use server';

import { headers } from 'next/headers';
import { requestLogin } from '@/lib/db/login';
import { Invalid } from '@/lib/db/errors';
import { safeNext } from '@/lib/next-param';

/**
 * Запрос ссылки для входа.
 *
 * Подпись с первым аргументом — требование useActionState. Благодаря ей
 * форма работает и БЕЗ JavaScript: браузер отправляет её обычным POST, а
 * не остаётся с неработающей кнопкой.
 *
 * Ответ одинаков для известной и неизвестной почты — так решено в слое
 * доступа и объяснено там же: иначе форма входа превращается в проверку
 * «есть ли такой агент».
 */
export type LoginState = { sent: boolean; email: string | null; error: string | null };

export async function requestLoginLink(
  _prev: LoginState | null,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const next = safeNext(String(formData.get('next') ?? ''));

  // Полный адрес сайта: ссылка в письме обязана быть абсолютной, а какой
  // адрес у сайта, знает только запрос. Брать его из переменной значило бы
  // присылать ссылку на боевой сайт при проверке на другом.
  const incoming = await headers();
  const host = incoming.get('host') ?? '';
  const proto = incoming.get('x-forwarded-proto') ?? 'https';
  const origin = `${proto}://${host}`;

  try {
    await requestLogin({ email, redirect_to: next, origin });
    return { sent: true, email, error: null };
  } catch (e) {
    if (e instanceof Invalid) return { sent: false, email, error: e.message };

    // Отправка не настроена или почтовик отказал. Говорим прямо: человек
    // будет ждать письма, которого нет, и это худшее из возможного.
    return {
      sent: false,
      email,
      error: 'Не удалось отправить письмо. Сообщите администратору.',
    };
  }
}
