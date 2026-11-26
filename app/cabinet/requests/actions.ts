'use server';

import { revalidatePath } from 'next/cache';
import {
  answerRequest as reportAnswer, closeRequest as close,
  convertRequest as convert, releaseRequest as release, takeRequest as take,
} from '@/lib/db/requests';
import { attempt } from '@/lib/db/report';

export type RequestActionResult = { error: string | null };

/**
 * Действия над заявкой.
 *
 * Права и состояния проверяет слой доступа: он знает, кто ведёт заявку и
 * в каком она состоянии. Взятие в работу идёт одним запросом с условием
 * «ещё не взята» — иначе два агента, нажавшие одновременно, оба увидели бы
 * «свободна» и оба записали бы себя.
 */
function touch(): void {
  revalidatePath('/cabinet/requests');
  revalidatePath('/cabinet');
}

export async function takeRequest(formData: FormData): Promise<RequestActionResult> {
  const error = await attempt(() => take(String(formData.get('id') ?? '')));
  touch();
  return { error };
}

export async function releaseRequest(formData: FormData): Promise<RequestActionResult> {
  const error = await attempt(() => release(String(formData.get('id') ?? '')));
  touch();
  return { error };
}

export async function answerRequest(formData: FormData): Promise<RequestActionResult> {
  const error = await attempt(() => reportAnswer(String(formData.get('id') ?? '')));
  touch();
  return { error };
}

export async function closeRequest(formData: FormData): Promise<RequestActionResult> {
  const error = await attempt(() => close(
    String(formData.get('id') ?? ''),
    String(formData.get('reason') ?? 'other') as Parameters<typeof close>[1],
  ));
  touch();
  return { error };
}

/** Превращение заявки в клиента и потребность: отсюда начинается работа CRM. */
export async function convertRequest(formData: FormData): Promise<RequestActionResult> {
  const error = await attempt(() => convert(String(formData.get('id') ?? '')));
  touch();
  revalidatePath('/cabinet/contacts');
  revalidatePath('/cabinet/requirements');
  return { error };
}
