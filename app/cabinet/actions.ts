'use server';

import { revalidatePath } from 'next/cache';
import { createMatch as makeMatch } from '@/lib/db/matches';
import { attempt } from '@/lib/db/report';

/**
 * Создать подбор.
 *
 * Кабинет передаёт только пару «объект + потребность». closing-агента и
 * проверку совпадения направления сделки делает слой доступа, а не этот
 * код: закрытие формы не должно быть единственным местом, где правило
 * соблюдается. closing-агент при этом берётся из потребности — кто бы
 * подбор ни создал, доля комиссии идёт тому, кто ведёт клиента.
 */
export async function createMatch(formData: FormData) {
  const objectId = String(formData.get('object_id') ?? '');
  const requirementId = String(formData.get('requirement_id') ?? '');
  const back = String(formData.get('back') ?? '/cabinet');

  if (!objectId || !requirementId) {
    return { error: 'Выберите объект и потребность.' };
  }

  const error = await attempt(() => makeMatch(objectId, requirementId));
  if (error) return { error };

  revalidatePath(back);
  return { error: null };
}
