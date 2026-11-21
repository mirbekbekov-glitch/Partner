'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type ProfileResult = { error: string | null; saved: boolean };

/**
 * Сохранение своего профиля.
 *
 * Обрезку, запрет пустого имени и привязку к своей строке делает
 * update_my_profile() в базе. Здесь только передача и показ ответа:
 * проверка в server action защищала бы лишь этот путь, а не прямой
 * запрос к PostgREST.
 */
export async function saveProfile(formData: FormData): Promise<ProfileResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc('update_my_profile', {
    p_full_name: String(formData.get('full_name') ?? ''),
    p_phone: String(formData.get('phone') ?? ''),
  });

  if (error) return { error: error.message, saved: false };

  // Агентство — отдельной функцией: агент его ЗАЯВЛЯЕТ, а подтверждает
  // админ, и смешивать это с правкой имени нельзя. «Частный агент» — это
  // отсутствие организации, поэтому пустое поле снимает связь.
  const org = String(formData.get('organization') ?? '').trim();
  const solo = formData.get('solo') === 'on';
  const orgCall = solo || org === ''
    ? supabase.rpc('clear_my_organization')
    : supabase.rpc('set_my_organization', { p_name: org });
  const { error: orgError } = await orgCall;
  if (orgError) {
    return {
      error: orgError.message.includes('BAD_INPUT')
        ? 'Название агентства — от 2 до 120 символов.'
        : orgError.message,
      saved: false,
    };
  }

  // Имя показывается в верхней полосе на каждой странице кабинета.
  revalidatePath('/cabinet', 'layout');
  return { error: null, saved: true };
}
