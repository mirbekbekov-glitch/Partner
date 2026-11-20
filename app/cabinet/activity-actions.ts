'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type ActivityResult = { error: string | null };

const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

function touch() {
  // Активность висит на сущности и попадает в личный список задач.
  revalidatePath('/cabinet/activities');
  revalidatePath('/cabinet/objects', 'layout');
  revalidatePath('/cabinet/requirements', 'layout');
  revalidatePath('/cabinet/deals', 'layout');
  revalidatePath('/cabinet');
}

/**
 * Запись активности.
 *
 * agent_id не передаётся: у колонки серверное значение по умолчанию
 * app.current_agent_id(), и подарить активность другому агенту нечем —
 * колонка клиенту не выдана.
 */
export async function addActivity(formData: FormData): Promise<ActivityResult> {
  const supabase = await createClient();

  const { error } = await supabase.from('activities').insert({
    kind: str(formData.get('kind')),
    entity_type: str(formData.get('entity_type')),
    entity_id: str(formData.get('entity_id')),
    body: str(formData.get('body')),
    due_at: str(formData.get('due_at')),
    is_shared: formData.get('is_shared') === 'on',
  });

  touch();
  return { error: error ? error.message : null };
}

/** Отметка выполнения. Дату выполнения ставит триггер, не этот код. */
export async function toggleActivity(formData: FormData): Promise<ActivityResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('activities')
    .update({ done: formData.get('done') === 'true' })
    .eq('id', String(formData.get('id') ?? ''));

  touch();
  return { error: error ? error.message : null };
}

export async function deleteActivity(formData: FormData): Promise<ActivityResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('activities')
    .delete()
    .eq('id', String(formData.get('id') ?? ''));

  touch();
  return { error: error ? error.message : null };
}
