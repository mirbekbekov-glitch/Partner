'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type ContactResult = { error: string | null };
export type LookupResult = {
  found: boolean;
  visible?: boolean;
  owner_name?: string | null;
  contact_id?: string | null;
  name?: string | null;
};

const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

const roles = (formData: FormData) =>
  formData.getAll('roles').map(String).filter(Boolean);

/**
 * Поиск контакта по телефону ПЕРЕД созданием.
 *
 * «Один человек — одна запись» — правило из задания, и телефон теперь
 * уникален глобально. Без этого поиска правило только наказывало бы за
 * дубликат: агент узнавал бы о существующей записи из ошибки сохранения.
 */
export async function lookupByPhone(phone: string): Promise<LookupResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('find_contact_by_phone', { p_phone: phone });
  if (error) return { found: false };
  return data as LookupResult;
}

export async function createContact(formData: FormData): Promise<ContactResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      kind: str(formData.get('kind')) ?? 'person',
      name: str(formData.get('name')),
      telegram: str(formData.get('telegram')),
      source: str(formData.get('source')),
      roles: roles(formData),
      note: str(formData.get('note')),
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  const phone = str(formData.get('phone'));
  if (phone) {
    const { error: phoneError } = await supabase
      .from('contact_phones')
      .insert({ contact_id: data.id, phone, is_primary: true });

    // Контакт уже создан, а телефон не прошёл: честнее сказать об этом и
    // отправить на карточку, чем молча потерять номер.
    if (phoneError) {
      revalidatePath('/cabinet/contacts');
      return {
        error:
          `Контакт создан, но телефон не сохранён: ${phoneError.message}. ` +
          `Добавьте номер на карточке.`,
      };
    }
  }

  revalidatePath('/cabinet/contacts');
  redirect(`/cabinet/contacts/${data.id}`);
}

export async function updateContact(formData: FormData): Promise<ContactResult> {
  const supabase = await createClient();
  const id = String(formData.get('id') ?? '');

  const { error } = await supabase
    .from('contacts')
    .update({
      kind: str(formData.get('kind')) ?? 'person',
      name: str(formData.get('name')),
      telegram: str(formData.get('telegram')),
      source: str(formData.get('source')),
      roles: roles(formData),
      note: str(formData.get('note')),
    })
    .eq('id', id);

  if (error) return { error: error.message };

  revalidatePath(`/cabinet/contacts/${id}`);
  revalidatePath('/cabinet/contacts');
  return { error: null };
}

export async function addPhone(formData: FormData): Promise<ContactResult> {
  const supabase = await createClient();
  const id = String(formData.get('contact_id') ?? '');

  const { error } = await supabase.from('contact_phones').insert({
    contact_id: id,
    phone: str(formData.get('phone')),
    label: str(formData.get('label')),
  });

  revalidatePath(`/cabinet/contacts/${id}`);
  return { error: error ? error.message : null };
}

export async function removePhone(formData: FormData): Promise<ContactResult> {
  const supabase = await createClient();
  const id = String(formData.get('contact_id') ?? '');

  const { error } = await supabase
    .from('contact_phones')
    .delete()
    .eq('id', String(formData.get('phone_id') ?? ''));

  revalidatePath(`/cabinet/contacts/${id}`);
  return { error: error ? error.message : null };
}
