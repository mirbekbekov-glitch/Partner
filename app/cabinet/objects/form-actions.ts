'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type FormResult = { error: string | null };

/** Пустое поле формы — это «не задано», а не 0 и не пустая строка. */
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

export async function createObject(formData: FormData): Promise<FormResult> {
  const supabase = await createClient();

  const mandateKind = str(formData.get('mandate_kind'));

  const { data, error } = await supabase.rpc('create_object', {
    p_kind: str(formData.get('kind')),
    p_deal_type: str(formData.get('deal_type')),
    p_address: str(formData.get('address')),
    p_price: num(formData.get('price')),
    p_zone: str(formData.get('zone')),
    p_rooms: num(formData.get('rooms')),
    p_area: num(formData.get('area')),
    p_floor: num(formData.get('floor')),
    p_floors_total: num(formData.get('floors_total')),
    p_currency: str(formData.get('currency')) ?? 'USD',
    p_description: str(formData.get('description')),
    p_photos: str(formData.get('photos')),
    p_owner_name: str(formData.get('owner_name')),
    p_owner_phone: str(formData.get('owner_phone')),
    // Мандат создаётся только если вид выбран: иначе объект заводится
    // без договора сознательно.
    p_mandate_kind: mandateKind,
    p_mandate_valid_to: str(formData.get('mandate_valid_to')),
    p_mandate_start_price: num(formData.get('mandate_start_price')),
    p_contract_confirmed: formData.get('contract_confirmed') === 'on',
    p_document_url: str(formData.get('document_url')),
  });

  if (error) return { error: error.message };

  revalidatePath('/cabinet/objects');
  revalidatePath('/cabinet');
  redirect(`/cabinet/objects/${(data as { id: string }).id}`);
}

export async function updateObject(formData: FormData): Promise<FormResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');

  const { error } = await supabase.rpc('update_object', {
    p_id: id,
    p_kind: str(formData.get('kind')),
    p_deal_type: str(formData.get('deal_type')),
    p_address: str(formData.get('address')),
    p_price: num(formData.get('price')),
    p_zone: str(formData.get('zone')),
    p_rooms: num(formData.get('rooms')),
    p_area: num(formData.get('area')),
    p_floor: num(formData.get('floor')),
    p_floors_total: num(formData.get('floors_total')),
    p_currency: str(formData.get('currency')) ?? 'USD',
    p_description: str(formData.get('description')),
    p_photos: str(formData.get('photos')),
  });

  if (error) return { error: error.message };

  revalidatePath(`/cabinet/objects/${id}`);
  revalidatePath('/cabinet/objects');
  redirect(`/cabinet/objects/${id}`);
}

/** Публикация, снятие, мандат — действия с карточки объекта. */
export async function objectAction(formData: FormData): Promise<FormResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');
  const what = String(formData.get('what') ?? '');

  let error = null;

  if (what === 'publish') {
    ({ error } = await supabase.rpc('publish_object', { p_object_id: id }));
  } else if (what === 'withdraw') {
    ({ error } = await supabase.rpc('withdraw_object', { p_object_id: id }));
  } else if (what === 'confirm_actual') {
    ({ error } = await supabase.rpc('confirm_actual', { p_object_id: id }));
  } else if (what === 'create_mandate') {
    ({ error } = await supabase.rpc('create_mandate', {
      p_object_id: id,
      p_kind: str(formData.get('mandate_kind')) ?? 'non_exclusive',
      p_valid_to: str(formData.get('mandate_valid_to')),
      p_contract_confirmed: formData.get('contract_confirmed') === 'on',
      p_document_url: str(formData.get('document_url')),
    }));
  } else if (what === 'terminate_mandate') {
    ({ error } = await supabase.rpc('terminate_mandate', {
      p_mandate_id: String(formData.get('mandate_id') ?? ''),
      p_reason: str(formData.get('reason')),
    }));
  } else {
    return { error: 'Неизвестное действие.' };
  }

  if (error) return { error: error.message };

  revalidatePath(`/cabinet/objects/${id}`);
  revalidatePath('/cabinet/objects');
  revalidatePath('/cabinet');
  return { error: null };
}
