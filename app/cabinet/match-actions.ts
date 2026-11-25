'use server';

import { revalidatePath } from 'next/cache';
import { setMatchStatus as applyStatus } from '@/lib/db/matches';
import { attempt } from '@/lib/db/report';

export type MatchResult = { error: string | null };

const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Смена статуса подбора.
 *
 * Требование причины для отказа и даты для показа проверяет слой доступа,
 * а не форма: правило, живущее в форме, действует только на тех, кто
 * пользуется формой.
 */
export async function setMatchStatus(formData: FormData): Promise<MatchResult> {
  const error = await attempt(() => applyStatus(
    String(formData.get('match_id') ?? ''),
    String(formData.get('status') ?? '') as Parameters<typeof applyStatus>[1],
    {
      reason: str(formData.get('reason')),
      showing_at: str(formData.get('showing_at')),
    },
  ));

  // Подбор виден с двух сторон, поэтому обновляем оба списка.
  revalidatePath('/cabinet/objects', 'layout');
  revalidatePath('/cabinet/requirements', 'layout');
  revalidatePath('/cabinet');

  return { error };
}
