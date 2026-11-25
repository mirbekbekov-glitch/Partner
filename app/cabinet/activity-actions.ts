'use server';

import { revalidatePath } from 'next/cache';
import {
  createActivity, deleteActivity as removeActivity, setActivityDone,
} from '@/lib/db/activities';
import { attempt } from '@/lib/db/report';

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
 * Агент не передаётся: слой доступа ставит того, кто вошёл. Подарить
 * активность другому нечем — параметр просто не принимается оттуда, где
 * его мог бы подставить браузер.
 */
export async function addActivity(formData: FormData): Promise<ActivityResult> {
  const error = await attempt(() => createActivity({
    kind: String(formData.get('kind') ?? '') as 'call',
    entity_type: String(formData.get('entity_type') ?? '') as 'object',
    entity_id: String(formData.get('entity_id') ?? ''),
    body: str(formData.get('body')),
    due_at: str(formData.get('due_at')),
    is_shared: formData.get('is_shared') === 'on',
  }));

  touch();
  return { error };
}

/**
 * Отметка выполнения.
 *
 * Дату выполнения ставит слой доступа, а не этот код. Он же гасит
 * напоминание тем же батчем: иначе выполненная задача всё равно дёрнула бы
 * агента — напоминание уже стояло в очереди.
 */
export async function toggleActivity(formData: FormData): Promise<ActivityResult> {
  const error = await attempt(() => setActivityDone(
    String(formData.get('id') ?? ''),
    formData.get('done') === 'true',
  ));

  touch();
  return { error };
}

export async function deleteActivity(formData: FormData): Promise<ActivityResult> {
  const error = await attempt(() => removeActivity(String(formData.get('id') ?? '')));

  touch();
  return { error };
}
