'use server';

import { revalidatePath } from 'next/cache';
import {
  clearMyOrganization, setMyOrganization, updateProfile,
} from '@/lib/db/agents';
import { startTelegramLink, unlinkTelegram } from '@/lib/db/telegram';
import { explain } from '@/lib/db/report';

export type ProfileResult = { error: string | null; saved: boolean };

/**
 * Сохранение своего профиля.
 *
 * Обрезку, запрет пустого имени и привязку к своей строке делает слой
 * доступа. Он же не даёт протащить сюда роль или статус: updateProfile()
 * принимает ровно три поля, и это главное свойство функции, а не деталь.
 */
export async function saveProfile(formData: FormData): Promise<ProfileResult> {
  try {
    // Пустое поле — это «не указано», а не «ноль»: иначе стёртый год
    // превратился бы в 0, а тот не пройдёт проверку и уронит сохранение
    // всей формы, включая имя.
    const year = String(formData.get('works_since') ?? '').trim();

    await updateProfile({
      full_name: String(formData.get('full_name') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      works_since: year === '' ? null : Number.parseInt(year, 10),
      certificate_no: String(formData.get('certificate_no') ?? ''),
    });

    // Агентство — отдельной функцией: агент его ЗАЯВЛЯЕТ, а подтверждает
    // админ, и смешивать это с правкой имени нельзя. «Частный агент» — это
    // отсутствие организации, поэтому пустое поле снимает связь.
    const org = String(formData.get('organization') ?? '').trim();
    const solo = formData.get('solo') === 'on';

    if (solo || org === '') await clearMyOrganization();
    else await setMyOrganization(org);
  } catch (e) {
    return { error: explain(e), saved: false };
  }

  // Имя показывается в верхней полосе на каждой странице кабинета.
  revalidatePath('/cabinet', 'layout');
  return { error: null, saved: true };
}

export type LinkResult = { error: string | null; url: string | null };

/**
 * Получить ссылку на бота.
 *
 * Ссылка возвращается в разметку, а не уводит перенаправлением: человек
 * может открыть её на телефоне, где и стоит Telegram, а не в том
 * браузере, где открыт кабинет. Поэтому её надо показать, а не открыть.
 */
export async function requestTelegramLink(): Promise<LinkResult> {
  try {
    const { url } = await startTelegramLink();
    return { error: null, url };
  } catch (e) {
    return { error: explain(e), url: null };
  }
}

/** Отвязать свой Telegram. */
export async function dropTelegram(): Promise<{ error: string | null }> {
  try {
    await unlinkTelegram();
    revalidatePath('/cabinet/profile');
    return { error: null };
  } catch (e) {
    return { error: explain(e) };
  }
}
