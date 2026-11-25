'use server';

import { revalidatePath } from 'next/cache';
import {
  closeDeal as finishDeal, createDealFromMatch, failDeal as breakDeal,
  setDealStatus,
} from '@/lib/db/deals';
import { toMinor } from '@/lib/db/money';
import { attempt } from '@/lib/db/report';

export type DealResult = { error: string | null };

/**
 * Цена из формы в минорные единицы.
 *
 * Человек вводит «38 000» или «38000,50», а в базе деньги целые: комиссия
 * делится пополам, и дробная арифметика теряла бы копейку.
 */
const money = (v: FormDataEntryValue | null) => toMinor(String(v ?? ''));

function touch(id?: string) {
  if (id) revalidatePath(`/cabinet/deals/${id}`);
  revalidatePath('/cabinet/deals');
  revalidatePath('/cabinet');
}

/**
 * Создание сделки из подбора.
 *
 * Передаётся только match_id: объект, потребность, мандат и обе стороны
 * комиссии выводит слой доступа из подбора и активного мандата (инварианты
 * 2 и 3). Передать стороны снаружи означало бы дать выписать комиссию на
 * себя.
 */
export async function startDeal(formData: FormData): Promise<DealResult> {
  const error = await attempt(() => createDealFromMatch(
    String(formData.get('match_id') ?? ''),
  ));
  touch();
  revalidatePath(`/cabinet/objects/${String(formData.get('object_id') ?? '')}`);
  revalidatePath(`/cabinet/requirements/${String(formData.get('requirement_id') ?? '')}`);
  return { error };
}

export async function advanceDeal(formData: FormData): Promise<DealResult> {
  const id = String(formData.get('id') ?? '');
  const error = await attempt(() => setDealStatus(
    id,
    String(formData.get('status') ?? '') as Parameters<typeof setDealStatus>[1],
  ));
  touch(id);
  return { error };
}

/** Закрытие фиксирует комиссию от финальной цены — это необратимо. */
export async function closeDeal(formData: FormData): Promise<DealResult> {
  const id = String(formData.get('id') ?? '');
  const price = money(formData.get('final_price'));

  if (price === null) {
    return { error: 'Укажите финальную цену: от неё считается комиссия.' };
  }

  const error = await attempt(() => finishDeal(id, price));
  touch(id);
  return { error };
}

export async function failDeal(formData: FormData): Promise<DealResult> {
  const id = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (reason === '') {
    return { error: 'Укажите причину срыва.' };
  }

  const error = await attempt(() => breakDeal(id, reason));
  touch(id);
  return { error };
}
