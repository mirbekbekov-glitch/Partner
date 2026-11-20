'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type DealResult = { error: string | null };

const num = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function touch(id?: string) {
  if (id) revalidatePath(`/cabinet/deals/${id}`);
  revalidatePath('/cabinet/deals');
  revalidatePath('/cabinet');
}

/**
 * Создание сделки из подбора.
 *
 * Передаётся только match_id: объект, потребность, мандат и обе стороны
 * комиссии выводит база из подбора и активного мандата (инварианты 2 и 3).
 */
export async function startDeal(formData: FormData): Promise<DealResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('create_deal_from_match', {
    p_match_id: String(formData.get('match_id') ?? ''),
  });
  touch();
  revalidatePath(`/cabinet/objects/${String(formData.get('object_id') ?? '')}`);
  revalidatePath(`/cabinet/requirements/${String(formData.get('requirement_id') ?? '')}`);
  return { error: error ? error.message : null };
}

export async function advanceDeal(formData: FormData): Promise<DealResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');
  const { error } = await supabase.rpc('set_deal_status', {
    p_deal_id: id,
    p_status: String(formData.get('status') ?? ''),
  });
  touch(id);
  return { error: error ? error.message : null };
}

/** Закрытие фиксирует комиссию от финальной цены — это необратимо. */
export async function closeDeal(formData: FormData): Promise<DealResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');
  const price = num(formData.get('final_price'));

  if (price === null) {
    return { error: 'Укажите финальную цену: от неё считается комиссия.' };
  }

  const { error } = await supabase.rpc('close_deal', {
    p_deal_id: id,
    p_final_price: price,
  });
  touch(id);
  return { error: error ? error.message : null };
}

export async function failDeal(formData: FormData): Promise<DealResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (reason === '') {
    return { error: 'Укажите причину срыва.' };
  }

  const { error } = await supabase.rpc('fail_deal', {
    p_deal_id: id,
    p_reason: reason,
  });
  touch(id);
  return { error: error ? error.message : null };
}
