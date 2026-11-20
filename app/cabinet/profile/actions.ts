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

  // Имя показывается в верхней полосе на каждой странице кабинета.
  revalidatePath('/cabinet', 'layout');
  return { error: null, saved: true };
}
