'use server';

import { revalidatePath } from 'next/cache';
import { setLeadStatus as applyStatus } from '@/lib/db/leads';
import { attempt } from '@/lib/db/report';

export type LeadActionResult = { error: string | null };

/**
 * Смена статуса заявки.
 *
 * Права проверяет слой доступа: заявки ведёт тот, кто ведёт объект. Здесь
 * только передача значений формы.
 */
export async function setLeadStatus(formData: FormData): Promise<LeadActionResult> {
  const error = await attempt(() => applyStatus(
    String(formData.get('lead_id') ?? ''),
    String(formData.get('status') ?? '') as Parameters<typeof applyStatus>[1],
  ));

  if (error) return { error };

  revalidatePath('/cabinet/leads');
  return { error: null };
}
