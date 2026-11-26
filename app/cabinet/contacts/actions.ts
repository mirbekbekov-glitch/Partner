'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addPhone as attachPhone, createContact as addContact, findContactByPhone,
  mergeContacts as joinContacts, removeObjectOwnership, removePhone as detachPhone,
  setObjectOwnership, updateContact as editContact,
} from '@/lib/db/contacts';
import { attempt, explain } from '@/lib/db/report';

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
  try {
    return await findContactByPhone(phone) as LookupResult;
  } catch {
    // Подсказка не обязана работать: если не вышло, агент просто не увидит
    // предупреждения о дубликате, а сохранение всё равно его не пропустит.
    return { found: false } as LookupResult;
  }
}

export async function createContact(formData: FormData): Promise<ContactResult> {
  let id: string;

  try {
    const created = await addContact({
      kind: (str(formData.get('kind')) ?? 'person') as 'person',
      name: str(formData.get('name')) ?? '',
      telegram: str(formData.get('telegram')),
      source: str(formData.get('source')),
      roles: roles(formData),
      note: str(formData.get('note')),
      // Телефон уходит вместе с контактом одним батчем: иначе возможно
      // состояние «контакт создан, номер потерян», и агент узнаёт об этом
      // только когда не может позвонить.
      phone: str(formData.get('phone')),
    });
    id = created.id;
  } catch (e) {
    return { error: explain(e) };
  }

  revalidatePath('/cabinet/contacts');
  redirect(`/cabinet/contacts/${id}`);
}

export async function updateContact(formData: FormData): Promise<ContactResult> {
  const id = String(formData.get('id') ?? '');

  const error = await attempt(() => editContact(id, {
    kind: (str(formData.get('kind')) ?? 'person') as 'person',
    name: str(formData.get('name')) ?? '',
    telegram: str(formData.get('telegram')),
    source: str(formData.get('source')),
    roles: roles(formData),
    note: str(formData.get('note')),
  }));

  if (error) return { error };

  revalidatePath(`/cabinet/contacts/${id}`);
  revalidatePath('/cabinet/contacts');
  return { error: null };
}

export async function addPhone(formData: FormData): Promise<ContactResult> {
  const id = String(formData.get('contact_id') ?? '');

  const error = await attempt(() => attachPhone(
    id,
    String(formData.get('phone') ?? ''),
    { label: str(formData.get('label')) },
  ));

  revalidatePath(`/cabinet/contacts/${id}`);
  return { error };
}

export async function removePhone(formData: FormData): Promise<ContactResult> {
  const id = String(formData.get('contact_id') ?? '');

  const error = await attempt(() => detachPhone(String(formData.get('phone_id') ?? '')));

  revalidatePath(`/cabinet/contacts/${id}`);
  return { error };
}

export type MergeResult = { error: string | null; done: string | null };

/**
 * Объединение двух записей одного человека.
 *
 * Что именно переезжает и в каком порядке, решает слой доступа. Порядок
 * там не стилистика: requirements и contact_phones ссылаются на контакт с
 * ON DELETE CASCADE, и удаление лишней записи раньше переноса уничтожило
 * бы потребности клиента — молча, без единой ошибки.
 */
export async function mergeContacts(formData: FormData): Promise<MergeResult> {
  const keep = String(formData.get('keep_id') ?? '');

  let r;
  try {
    r = await joinContacts(keep, String(formData.get('merge_id') ?? ''));
  } catch (e) {
    return { error: explain(e), done: null };
  }

  revalidatePath('/cabinet/contacts', 'layout');
  revalidatePath('/cabinet');

  const parts = [
    `телефонов ${r.phones}`,
    `потребностей ${r.requirements}`,
    `объектов ${r.ownerships}`,
    `записей ${r.activities}`,
  ];

  return {
    error: null,
    done:
      `Запись «${r.merged_name}» присоединена к «${r.kept_name}». ` +
      `Перенесено: ${parts.join(', ')}.` +
      (r.ownerships_dropped > 0
        ? ` Дублирующих связей с объектами убрано: ${r.ownerships_dropped}.`
        : ''),
  };
}

export type OwnershipResult = { error: string | null };

/**
 * Связь контакта с объектом.
 *
 * Роль входит в составной ключ (object_id, contact_id, role), поэтому смена
 * роли — это перенос, а не UPDATE одной строки: наивная правка оставила бы
 * у человека две роли по одному объекту. Это скрыто в слое доступа.
 *
 * Там же проверка, что сумма долей по объекту не выходит за единицу: это
 * межстрочное правило, и CHECK его не удержал бы — он видит только свою
 * строку.
 */
export async function setOwnership(formData: FormData): Promise<OwnershipResult> {
  const contactId = String(formData.get('contact_id') ?? '');

  const shareRaw = String(formData.get('share') ?? '').trim().replace(',', '.');
  const share = shareRaw === '' ? null : Number(shareRaw);

  if (share !== null && !Number.isFinite(share)) {
    return { error: 'Доля должна быть числом, например 0.5 для половины.' };
  }

  const error = await attempt(() => setObjectOwnership(
    String(formData.get('object_id') ?? ''),
    contactId,
    (String(formData.get('role') ?? 'owner')) as 'owner',
    share,
  ));

  revalidatePath(`/cabinet/contacts/${contactId}`);
  revalidatePath('/cabinet/objects', 'layout');
  return { error };
}

export async function removeOwnership(formData: FormData): Promise<OwnershipResult> {
  const contactId = String(formData.get('contact_id') ?? '');

  const error = await attempt(() => removeObjectOwnership(
    String(formData.get('object_id') ?? ''),
    contactId,
    String(formData.get('role') ?? 'owner'),
  ));

  revalidatePath(`/cabinet/contacts/${contactId}`);
  revalidatePath('/cabinet/objects', 'layout');
  return { error };
}
