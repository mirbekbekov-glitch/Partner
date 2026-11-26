'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createRequirement as addRequirement, updateRequirement as editRequirement,
} from '@/lib/db/requirements';
import { toMinor } from '@/lib/db/money';
import { attempt, explain } from '@/lib/db/report';

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

/** Бюджет из формы в минорные единицы: в базе деньги целые. */
const money = (v: FormDataEntryValue | null) => toMinor(String(v ?? ''));

/** Списки из формы: по строке или через запятую. */
const list = (v: FormDataEntryValue | null) =>
  String(v ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

/** Комнаты списком чисел. Нечисловое молча отбрасывается, а не роняет форму. */
const numbers = (v: FormDataEntryValue | null) =>
  list(v).map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n));

export async function createRequirement(formData: FormData): Promise<FormResult> {
  let id: string;

  try {
    const created = await addRequirement({
      deal_type: (str(formData.get('deal_type')) ?? 'sale') as 'sale',
      contact_id: str(formData.get('contact_id')),
      client_name: str(formData.get('client_name')),
      client_phone: str(formData.get('client_phone')),
      budget_min_minor: money(formData.get('budget_min')),
      budget_max_minor: money(formData.get('budget_max')),
      zones: list(formData.get('zones')),
      rooms: numbers(formData.get('rooms')),
      deadline: str(formData.get('deadline')),
      requirements_text: str(formData.get('requirements_text')),
    });
    id = created.id;
  } catch (e) {
    return { error: explain(e) };
  }

  revalidatePath('/cabinet/requirements');
  revalidatePath('/cabinet');
  redirect(`/cabinet/requirements/${id}`);
}

export async function updateRequirement(formData: FormData): Promise<FormResult> {
  const id = String(formData.get('id') ?? '');

  const error = await attempt(() => editRequirement(id, {
    budget_min_minor: money(formData.get('budget_min')),
    budget_max_minor: money(formData.get('budget_max')),
    zones: list(formData.get('zones')),
    rooms: numbers(formData.get('rooms')),
    deadline: str(formData.get('deadline')),
    requirements_text: str(formData.get('requirements_text')),
    status: (str(formData.get('status')) ?? undefined) as 'new' | undefined,
    closed_reason: str(formData.get('closed_reason')),
  }));

  if (error) return { error };

  revalidatePath(`/cabinet/requirements/${id}`);
  revalidatePath('/cabinet/requirements');
  redirect(`/cabinet/requirements/${id}`);
}
