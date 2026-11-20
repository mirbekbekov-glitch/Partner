'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type TransferResult = { error: string | null; done: string | null };

/**
 * Передача клиента и объекта.
 *
 * Что именно переезжает и когда передача невозможна, решает база: перенос
 * затрагивает несколько таблиц и обязан быть одной транзакцией, а отказ при
 * открытых сделках — правило, а не подсказка формы.
 */
export async function transferContact(formData: FormData): Promise<TransferResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('transfer_contact', {
    p_contact_id: String(formData.get('contact_id') ?? ''),
    p_to_agent_id: String(formData.get('to_agent_id') ?? ''),
  });

  if (error) return { error: error.message, done: null };

  const r = data as { requirements: number; matches: number; contact_name: string };
  revalidatePath('/cabinet/requirements', 'layout');
  revalidatePath('/cabinet');

  return {
    error: null,
    done:
      `Клиент «${r.contact_name}» передан. Переехало потребностей: ` +
      `${r.requirements}, подборов: ${r.matches}.`,
  };
}

export async function transferObject(formData: FormData): Promise<TransferResult> {
  const supabase = await createClient();
  const id = String(formData.get('object_id') ?? '');
  const { data, error } = await supabase.rpc('transfer_object', {
    p_object_id: id,
    p_to_agent_id: String(formData.get('to_agent_id') ?? ''),
  });

  if (error) return { error: error.message, done: null };

  const r = data as { mandate_moved: boolean; address: string };
  revalidatePath(`/cabinet/objects/${id}`);
  revalidatePath('/cabinet/objects');
  revalidatePath('/cabinet');

  return {
    error: null,
    done:
      `Объект «${r.address}» передан.` +
      (r.mandate_moved ? ' Мандат переехал вместе с ним, а с ним и доля listing-агента.' : ''),
  };
}
