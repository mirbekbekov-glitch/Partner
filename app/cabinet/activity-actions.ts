'use server';

import { revalidatePath } from 'next/cache';
import {
  createActivity, deleteActivity as removeActivity, setActivityDone,
  reassignActivity as handOver,
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
 * Агент теперь передаётся: задачу ставят и на коллегу — «посмотри объект
 * вместо меня». Но значение из браузера проверяет слой доступа, и только
 * одобренный агент принимается; до появления этого поля параметр был
 * недоступен из формы, и непроверенным он быть не мог.
 *
 * Пусто означает «себе». Поле приходит пустым и тогда, когда выбора в
 * форме не было вовсе — для заметки и звонка его не показывают.
 */
export async function addActivity(formData: FormData): Promise<ActivityResult> {
  const error = await attempt(() => createActivity({
    kind: String(formData.get('kind') ?? '') as 'call',
    entity_type: String(formData.get('entity_type') ?? '') as 'object',
    entity_id: String(formData.get('entity_id') ?? ''),
    body: str(formData.get('body')),
    due_at: str(formData.get('due_at')),
    is_shared: formData.get('is_shared') === 'on',
    agent_id: str(formData.get('agent_id')),
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

/**
 * Передать запись коллеге.
 *
 * Правило «передаёт тот, на ком она, или админ» живёт в слое доступа, а не
 * здесь: эта функция защищает только путь через форму. Там же живёт и
 * перенос напоминания — без него «позвоните клиенту» уехало бы прежнему
 * владельцу по задаче, которой у него больше нет.
 */
export async function reassign(formData: FormData): Promise<ActivityResult> {
  const error = await attempt(() => handOver(
    String(formData.get('id') ?? ''),
    String(formData.get('to_agent_id') ?? ''),
  ));

  touch();
  return { error };
}
