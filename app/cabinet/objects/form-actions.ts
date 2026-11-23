'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { describeObject, type DraftResult } from '@/lib/ai/describe';

export type FormResult = { error: string | null };
export type { DraftResult };

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

/**
 * Черновик описания: модель пишет, агент правит и сохраняет.
 *
 * Проверку прав здесь приходится делать руками. Остальные действия на этой
 * странице опираются на RLS: она не пустит чужого к чужой строке, что бы ни
 * прислал клиент. Но модель живёт вне базы, RLS её не прикрывает, и без
 * этой проверки любой, кто дотянулся до действия, тратил бы деньги на
 * генерацию. Поэтому: вошёл, запись агента есть, статус «одобрен».
 *
 * Ничего не сохраняется: результат возвращается в форму. Описание
 * попадает в базу тогда же, когда и остальные поля, — когда агент нажал
 * «Сохранить», прочитав текст.
 */
export async function draftDescription(formData: FormData): Promise<DraftResult> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { text: null, error: 'Сессия истекла. Войдите заново.' };

  const { data: agent } = await supabase
    .from('agents')
    .select('status')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (!agent || agent.status !== 'approved') {
    return { text: null, error: 'Генерация доступна одобренным агентам.' };
  }

  return describeObject({
    kind: str(formData.get('kind')) ?? 'flat',
    deal_type: str(formData.get('deal_type')) ?? 'sale',
    address: str(formData.get('address')),
    zone: str(formData.get('zone')),
    rooms: num(formData.get('rooms')),
    area: num(formData.get('area')),
    floor: num(formData.get('floor')),
    floors_total: num(formData.get('floors_total')),
    price: num(formData.get('price')),
    currency: str(formData.get('currency')),
    notes: str(formData.get('description')),
  });
}
