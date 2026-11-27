'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  confirmActual, createObject as addObject, publishObject,
  updateObject as editObject, withdrawObject,
} from '@/lib/db/objects';
import { createMandate, terminateMandate } from '@/lib/db/mandates';
import { currentAgent } from '@/lib/db/session';
import { toMinor } from '@/lib/db/money';
import { attempt, explain } from '@/lib/db/report';
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

/**
 * Цена из формы в минорные единицы.
 *
 * Человек вводит «55000», а в базе деньги целые: иначе комиссия, которая
 * делится пополам, теряла бы копейку на каждом делении.
 */
const money = (v: FormDataEntryValue | null) => toMinor(String(v ?? ''));

/**
 * Фотографии: по одной на строку или через запятую.
 *
 * Разбор здесь, а не в слое доступа: это форма ввода, а не правило
 * предметной области.
 */
const photos = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);


/**
 * Поля выгрузки из формы.
 *
 * Общие для создания и правки: иначе одно из двух мест однажды отстанет, и
 * объект, заведённый с координатами, потеряет их при первой же правке.
 *
 * Значения списков не проверяются здесь намеренно: в форме это выпадающие
 * списки, а окончательную проверку делает фид — он просто не возьмёт
 * значение, которого нет в справочнике площадки.
 */
const platformFields = (formData: FormData) => ({
  latitude: num(formData.get('latitude')),
  longitude: num(formData.get('longitude')),
  region: str(formData.get('region')),
  district: str(formData.get('district')),
  micro_district: str(formData.get('micro_district')),
  house_number: str(formData.get('house_number')),
  building_type: str(formData.get('building_type')),
  serie: str(formData.get('serie')),
  land_area: num(formData.get('land_area')),
  rental_term: str(formData.get('rental_term')),
  commercial_type: str(formData.get('commercial_type')),
  room_location: str(formData.get('room_location')),
  parking_type: str(formData.get('parking_type')),
  build_year: num(formData.get('build_year')),
});

export async function createObject(formData: FormData): Promise<FormResult> {
  const price = money(formData.get('price'));
  if (price === null) return { error: 'Укажите цену.' };

  const mandateKind = str(formData.get('mandate_kind'));
  let id: string;

  try {
    const created = await addObject({
      kind: str(formData.get('kind')) ?? 'flat',
      deal_type: (str(formData.get('deal_type')) ?? 'sale') as 'sale',
      address: str(formData.get('address')) ?? '',
      price_minor: price,
      city: str(formData.get('city')),
      zone: str(formData.get('zone')),
      rooms: num(formData.get('rooms')),
      area: num(formData.get('area')),
      floor: num(formData.get('floor')),
      floors_total: num(formData.get('floors_total')),
      currency: str(formData.get('currency')) ?? 'USD',
      description: str(formData.get('description')),
      ...platformFields(formData),
      photos: photos(formData.get('photos')),
      owner_name: str(formData.get('owner_name')),
      owner_phone: str(formData.get('owner_phone')),
      // Мандат создаётся, только если вид выбран: иначе объект заводится
      // без договора сознательно.
      mandate_kind: mandateKind as 'exclusive' | null,
      mandate_valid_to: str(formData.get('mandate_valid_to')),
      mandate_start_price_minor: money(formData.get('mandate_start_price')),
      contract_confirmed: formData.get('contract_confirmed') === 'on',
      document_url: str(formData.get('document_url')),
    });
    id = created.id;
  } catch (e) {
    return { error: explain(e) };
  }

  revalidatePath('/cabinet/objects');
  revalidatePath('/cabinet');
  redirect(`/cabinet/objects/${id}`);
}

export async function updateObject(formData: FormData): Promise<FormResult> {
  const id = String(formData.get('id') ?? '');
  const price = money(formData.get('price'));
  if (price === null) return { error: 'Укажите цену.' };

  const error = await attempt(() => editObject(id, {
    kind: str(formData.get('kind')) ?? undefined,
    deal_type: (str(formData.get('deal_type')) ?? undefined) as 'sale' | undefined,
    address: str(formData.get('address')) ?? undefined,
    price_minor: price,
    city: str(formData.get('city')) ?? undefined,
    zone: str(formData.get('zone')),
    rooms: num(formData.get('rooms')),
    area: num(formData.get('area')),
    floor: num(formData.get('floor')),
    floors_total: num(formData.get('floors_total')),
    currency: str(formData.get('currency')) ?? 'USD',
    description: str(formData.get('description')),
    photos: photos(formData.get('photos')),
    ...platformFields(formData),
  }));

  if (error) return { error };

  revalidatePath(`/cabinet/objects/${id}`);
  revalidatePath('/cabinet/objects');
  redirect(`/cabinet/objects/${id}`);
}

/** Публикация, снятие, мандат — действия с карточки объекта. */
export async function objectAction(formData: FormData): Promise<FormResult> {
  const id = String(formData.get('id') ?? '');
  const what = String(formData.get('what') ?? '');

  let error: string | null;

  if (what === 'publish') {
    error = await attempt(() => publishObject(id));
  } else if (what === 'withdraw') {
    error = await attempt(() => withdrawObject(id));
  } else if (what === 'confirm_actual') {
    error = await attempt(() => confirmActual(id));
  } else if (what === 'create_mandate') {
    error = await attempt(() => createMandate({
      object_id: id,
      kind: (str(formData.get('mandate_kind')) ?? 'non_exclusive') as 'non_exclusive',
      valid_to: str(formData.get('mandate_valid_to')),
      contract_confirmed: formData.get('contract_confirmed') === 'on',
      document_url: str(formData.get('document_url')),
    }));
  } else if (what === 'terminate_mandate') {
    error = await attempt(() => terminateMandate(
      String(formData.get('mandate_id') ?? ''),
      str(formData.get('reason')),
    ));
  } else {
    return { error: 'Неизвестное действие.' };
  }

  if (error) return { error };

  revalidatePath(`/cabinet/objects/${id}`);
  revalidatePath('/cabinet/objects');
  revalidatePath('/cabinet');
  return { error: null };
}

/**
 * Черновик описания: модель пишет, агент правит и сохраняет.
 *
 * Проверка прав здесь своя, и она нужна. Остальные действия страницы
 * кончаются обращением к слою доступа, который сам зовёт requireAgent().
 * Но модель живёт ВНЕ базы: генерация ничего не читает и не пишет, значит
 * ни одна проверка слоя доступа её не прикрывает. Без этой строки любой,
 * кто дотянулся до действия, тратил бы чужие деньги на генерацию.
 *
 * Ничего не сохраняется: результат возвращается в форму. Описание
 * попадает в базу тогда же, когда и остальные поля, — когда агент нажал
 * «Сохранить», прочитав текст.
 */
export async function draftDescription(formData: FormData): Promise<DraftResult> {
  if (!(await currentAgent())) {
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
