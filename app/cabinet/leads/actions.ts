'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type LeadActionResult = { error: string | null };

/**
 * Смена статуса заявки.
 *
 * Права проверяет set_lead_status() в базе: заявки ведёт тот, кто ведёт
 * объект. Здесь только перевод отказа в человеческую фразу.
 */
export async function setLeadStatus(formData: FormData): Promise<LeadActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_lead_status', {
    p_lead_id: String(formData.get('lead_id') ?? ''),
    p_status: String(formData.get('status') ?? ''),
  });

  if (error) {
    return {
      error: error.message.includes('FORBIDDEN')
        ? 'Эту заявку ведёт другой агент.'
        : error.message,
    };
  }

  revalidatePath('/cabinet/leads');
  return { error: null };
}
