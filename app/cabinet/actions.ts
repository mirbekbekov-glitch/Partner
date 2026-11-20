'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

/**
 * Создать подбор.
 *
 * Кабинет передаёт только пару «объект + потребность». closing_agent,
 * проверку совпадения типа сделки и запрет подбора по закрытой потребности
 * делает функция create_match() в базе, а не этот код: та же проверка должна
 * работать и при прямом обращении к PostgREST.
 */
export async function createMatch(formData: FormData) {
  const objectId = String(formData.get('object_id') ?? '');
  const requirementId = String(formData.get('requirement_id') ?? '');
  const back = String(formData.get('back') ?? '/cabinet');

  if (!objectId || !requirementId) {
    return { error: 'Выберите объект и потребность.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('create_match', {
    p_object_id: objectId,
    p_requirement_id: requirementId,
  });

  if (error) {
    // Сообщение из базы показываем как есть: там написано, какое правило
    // не выполнено, и это полезнее любой нашей формулировки.
    return { error: error.message };
  }

  revalidatePath(back);
  return { error: null };
}
