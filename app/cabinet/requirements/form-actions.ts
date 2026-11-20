'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type FormResult = { error: string | null };

const num = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

export async function createRequirement(formData: FormData): Promise<FormResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('create_requirement', {
    p_deal_type: str(formData.get('deal_type')),
    p_contact_id: str(formData.get('contact_id')),
    p_client_name: str(formData.get('client_name')),
    p_client_phone: str(formData.get('client_phone')),
    p_budget_min: num(formData.get('budget_min')),
    p_budget_max: num(formData.get('budget_max')),
    p_zones: str(formData.get('zones')),
    p_rooms: str(formData.get('rooms')),
    p_deadline: str(formData.get('deadline')),
    p_requirements_text: str(formData.get('requirements_text')),
  });

  if (error) return { error: error.message };

  revalidatePath('/cabinet/requirements');
  revalidatePath('/cabinet');
  redirect(`/cabinet/requirements/${(data as { id: string }).id}`);
}

export async function updateRequirement(formData: FormData): Promise<FormResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');

  const { error } = await supabase.rpc('update_requirement', {
    p_id: id,
    p_deal_type: str(formData.get('deal_type')),
    p_budget_min: num(formData.get('budget_min')),
    p_budget_max: num(formData.get('budget_max')),
    p_zones: str(formData.get('zones')),
    p_rooms: str(formData.get('rooms')),
    p_deadline: str(formData.get('deadline')),
    p_requirements_text: str(formData.get('requirements_text')),
    p_status: str(formData.get('status')),
    p_closed_reason: str(formData.get('closed_reason')),
  });

  if (error) return { error: error.message };

  revalidatePath(`/cabinet/requirements/${id}`);
  revalidatePath('/cabinet/requirements');
  redirect(`/cabinet/requirements/${id}`);
}
