'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type MatchResult = { error: string | null };

const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Смена статуса подбора.
 *
 * Требование причины для отказа и даты для показа проверяет база: иначе эти
 * правила действовали бы только в форме, а не при прямом запросе к PostgREST.
 */
export async function setMatchStatus(formData: FormData): Promise<MatchResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc('set_match_status', {
    p_match_id: String(formData.get('match_id') ?? ''),
    p_status: String(formData.get('status') ?? ''),
    p_reason: str(formData.get('reason')),
    p_showing_at: str(formData.get('showing_at')),
  });

  // Подбор виден с двух сторон, поэтому обновляем оба списка.
  revalidatePath('/cabinet/objects', 'layout');
  revalidatePath('/cabinet/requirements', 'layout');
  revalidatePath('/cabinet');

  return { error: error ? error.message : null };
}
