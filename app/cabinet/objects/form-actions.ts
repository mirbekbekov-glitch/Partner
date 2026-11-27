'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  confirmActual, createObject as addObject, publishObject,
  updateObject as editObject, withdrawObject,
} from '@/lib/db/objects';
import { createMandate, setMandateTerms, terminateMandate } from '@/lib/db/mandates';
import { currentAgent } from '@/lib/db/session';
import { updateProfile } from '@/lib/db/agents';
import { toMinor } from '@/lib/db/money';
import { attempt, explain } from '@/lib/db/report';
import { describeObject, type DraftResult } from '@/lib/ai/describe';
import { geocode, type Spot } from '@/lib/geocode';

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


/**
 * Телефон агента — обязателен при заведении объекта.
 *
 * Объявление без связи бессмысленно: покупатель читает карточку и не
 * может ничего спросить. Поэтому номер спрашивается там же, где всё
 * остальное, а не прячется в профиле, куда агент заходит раз в жизнь.
 *
 * Сохраняется он в профиль, а не в объект: номер у агента один, и держать
 * его копию в каждой карточке значит получить десять разных номеров
 * одного человека, из которых девять устареют.
 *
 * Чужой профиль не трогается. Номер записывается только тогда, когда он
 * отличается от своего же: админ, правящий чужой объект, иначе переписал
 * бы СВОЙ номер тем, что стоит в карточке коллеги.
 */
async function saveOwnPhone(formData: FormData): Promise<string | null> {
  const phone = str(formData.get('agent_phone'));
  if (!phone) return 'Впишите свой телефон: без него объявление не опубликовать.';

  const me = await currentAgent();
  if (me && (me.phone ?? '') !== phone) {
    try {
      await updateProfile({ phone });
    } catch (e) {
      return explain(e);
    }
  }

  return null;
}


/**
 * Комиссия из формы.
 *
 * Два числа, которые агент называет словами: сколько он берёт с объекта
 * и сколько отдаёт тому, кто приведёт покупателя. Первое пусто —
 * работает базовое правило (2 % при продаже, половина месяца при
 * аренде). Второе пусто — половина, обычай рынка.
 *
 * Процент при аренде считается от МЕСЯЧНОЙ платы, и это другая величина
 * справочника (months_share), а не процент цены: цена у аренды и есть
 * месячная плата, но правило должно называться тем, что оно значит.
 */
function commissionFields(formData: FormData, deal: string): {
  rule: string | null; rate: number | null;
} {
  const percent = num(formData.get('commission_percent'));
  const rule = percent === null ? null : JSON.stringify(
    deal === 'rent'
      ? { kind: 'months_share', value: percent / 100 }
      : { kind: 'percent', value: percent },
  );

  // Процент партнёра — от СДЕЛКИ, а не от нашей комиссии: «отдаю 1 % с
  // продажи», «отдаю 20 % месяца». Дробный разрешён: 0,5 % — обычное
  // условие при продаже.
  const rateRaw = str(formData.get('partner_rate'));
  const rate = rateRaw === null ? null : num(formData.get('partner_rate'));

  return { rule, rate };
}

export async function createObject(formData: FormData): Promise<FormResult> {
  const price = money(formData.get('price'));
  if (price === null) return { error: 'Укажите цену.' };

  const phoneError = await saveOwnPhone(formData);
  if (phoneError) return { error: phoneError };

  const commission = commissionFields(formData, str(formData.get('deal_type')) ?? 'sale');
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
      mandate_commission_rule: commission.rule,
      mandate_partner_rate: commission.rate,
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

  const phoneError = await saveOwnPhone(formData);
  if (phoneError) return { error: phoneError };

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
  } else if (what === 'commission_terms') {
    // Условия комиссии действующего договора: их меняют чаще, чем
    // заключают договор заново, и ради этого незачем расторгать мандат.
    const deal = str(formData.get('deal_type')) ?? 'sale';
    const commission = commissionFields(formData, deal);
    error = await attempt(() => setMandateTerms(
      String(formData.get('mandate_id') ?? ''),
      { commission_rule: commission.rule, partner_rate: commission.rate },
    ));
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


/**
 * Догадка о координатах по тому, что уже введено в карточке.
 *
 * Проверка на агента — по той же причине, что и у генерации описания:
 * действие ходит НАРУЖУ, мимо слоя доступа, и без этой строки любой, кто
 * дотянулся до него, ходил бы в чужую службу от нашего имени.
 *
 * Ничего не сохраняется: точка возвращается в форму, агент видит её на
 * карте и сохраняет вместе с остальными полями — или двигает, или
 * убирает. Догадка, записанная молча, однажды отправит покупателя не в
 * тот двор.
 */
export async function findOnMap(formData: FormData): Promise<{
  point: Spot | null;
  error?: string;
}> {
  if (!(await currentAgent())) {
    return { point: null, error: 'Поиск по адресу доступен одобренным агентам.' };
  }

  // Город и район сужают поиск: «Московская» есть и в Бишкеке, и в Оше.
  const query = [
    str(formData.get('address')),
    str(formData.get('zone')),
    str(formData.get('city')) ?? 'Бишкек',
  ].filter(Boolean).join(', ');

  if (!str(formData.get('address'))) {
    return { point: null, error: 'Сначала впишите адрес.' };
  }

  try {
    const point = await geocode(query);
    return point
      ? { point }
      : { point: null, error: 'По такому адресу ничего не нашлось — поставьте точку сами.' };
  } catch {
    // Служба чужая и может молчать. Это не повод ронять форму: карта
    // остаётся, точку всегда можно поставить рукой.
    return { point: null, error: 'Служба карт не ответила — поставьте точку сами.' };
  }
}
