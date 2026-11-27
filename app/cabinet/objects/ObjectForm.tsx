'use client';

import Link from 'next/link';
import { useActionState, useRef, useState, useTransition } from 'react';
import type { FormResult } from './form-actions';
import { draftDescription } from './form-actions';
import { PhotoUpload } from './PhotoUpload';
import { Suggest } from '../../Suggest';
import { citiesOf, zonesOf } from '@/lib/geo';
import {
  BUILDING_TYPE, COMMERCIAL_TYPE, DISTRICT, PARKING_TYPE, REGION,
  RENTAL_TERM, ROOM_LOCATION, SERIE,
} from '@/lib/mhouse';

export type ObjectDraft = {
  id?: string;
  kind: string;
  deal_type: string;
  address: string;
  city: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price: number | null;
  currency: string;
  description: string | null;
  photos: (string | { url?: string })[] | null;
  /* Поля для выгрузки на площадки. Пусто — объект в фид не уйдёт. */
  latitude?: number | null;
  longitude?: number | null;
  region?: string | null;
  district?: string | null;
  micro_district?: string | null;
  house_number?: string | null;
  building_type?: string | null;
  serie?: string | null;
  land_area?: number | null;
  rental_term?: string | null;
  commercial_type?: string | null;
  room_location?: string | null;
  parking_type?: string | null;
  build_year?: number | null;
};

/** Выпадающий список значений площадки: своё значение она не примет. */
function Pick({
  name, label, values, value, hint,
}: {
  name: string;
  label: string;
  values: readonly string[];
  value?: string | null;
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="key" htmlFor={name}>{label}</label>
      <select id={name} name={name} defaultValue={value ?? ''}>
        <option value="">не указано</option>
        {values.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
      {hint ? <p className="key">{hint}</p> : null}
    </div>
  );
}

const KINDS: [string, string][] = [
  ['flat', 'квартира'],
  ['room', 'комната'],
  ['house', 'дом'],
  ['townhouse', 'таунхаус'],
  ['land', 'участок'],
  ['commercial', 'коммерческая'],
  ['garage', 'гараж'],
];

export function ObjectForm({
  action,
  draft,
  mode,
}: {
  action: (fd: FormData) => Promise<FormResult>;
  draft?: ObjectDraft;
  mode: 'create' | 'edit';
}) {
  const [state, formAction, pending] = useActionState<FormResult, FormData>(
    async (_prev, fd) => action(fd),
    { error: null },
  );

  // Описание — управляемое поле: черновик приходит с сервера и должен
  // оказаться в том же поле, которое агент тут же правит руками.
  const [description, setDescription] = useState(draft?.description ?? '');
  // Город и район живут в состоянии, потому что связаны: подсказки
  // района берутся от набранного города.
  const [city, setCity] = useState(draft?.city ?? 'Бишкек');
  const [zone, setZone] = useState(draft?.zone ?? '');
  // Вид и сделка живут в состоянии: набор полей площадки у квартиры,
  // участка и паркинга разный, и показывать все сразу значит просить
  // агента заполнять то, чего у его объекта нет.
  const [kind, setKind] = useState(draft?.kind ?? 'flat');
  const [dealType, setDealType] = useState(draft?.deal_type ?? 'sale');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [drafting, startDrafting] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // Берём значения из самой формы, а не из состояния: поля, которые агент
  // только что заполнил, ещё нигде, кроме формы, не записаны, а черновик
  // без площади и этажа выйдет пустословным.
  const draftIt = () => {
    const form = formRef.current;
    if (!form) return;
    setDraftError(null);
    const fd = new FormData(form);
    startDrafting(async () => {
      const r = await draftDescription(fd);
      if (r.text) setDescription(r.text);
      setDraftError(r.error);
    });
  };

  // Снимки в базе лежат списком строк. Старые записи могли хранить объекты
  // с полем url — читаем оба вида, чтобы правка такой карточки не теряла
  // фотографии.
  const photoList = (draft?.photos ?? [])
    .map((p) => (typeof p === 'string' ? p : p?.url ?? ''))
    .filter(Boolean);

  return (
    <form ref={formRef} action={formAction} className="stack">
      {draft?.id ? <input type="hidden" name="id" value={draft.id} /> : null}

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="deal_type">Сделка</label>
          <select id="deal_type" name="deal_type" required
                  value={dealType} onChange={(e) => setDealType(e.target.value)}>
            <option value="sale">продажа</option>
            <option value="rent">аренда</option>
          </select>
        </div>
        <div className="field">
          <label className="key" htmlFor="kind">Тип</label>
          <select id="kind" name="kind" required
                  value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="grid2">
        <div className="field s4">
          <label className="key" htmlFor="address">Адрес</label>
          <input id="address" name="address" type="text" required
                 defaultValue={draft?.address ?? ''} placeholder="Чүй 120, кв. 5" />
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="price">Цена</label>
          <input id="price" name="price" type="text" inputMode="decimal" required
                 defaultValue={draft?.price ?? ''} />
          <p className="key">Для аренды — за месяц: комиссия считается от первого месяца.</p>
        </div>
        <div className="field">
          <label className="key" htmlFor="currency">Валюта</label>
          <select id="currency" name="currency" defaultValue={draft?.currency ?? 'USD'}>
            <option value="USD">USD</option>
            <option value="KGS">KGS</option>
          </select>
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="city">Город</label>
          {/* Значение подставлено, а не оставлено пустым: почти все объекты
              бишкекские, и заставлять агента печатать это каждый раз —
              лишняя работа ради редкого случая. Но поле на виду: объект
              из Оша иначе молча уехал бы в выгрузку как бишкекский. */}
          <Suggest id="city" name="city" value={city} onChange={setCity}
                   options={citiesOf(null)} placeholder="Бишкек" />
        </div>
        <div className="field">
          <label className="key" htmlFor="zone">Район</label>
          {/* Подсказки идут от набранного города: районы Бишкека в
              карточке каракольского объекта — чужая география. Писать
              своё можно: словарь отстаёт от жизни, и новый жилмассив не
              должен ждать, пока кто-то допишет файл. Но одно нажатие
              приводит написание к общему, и объект находится в поиске
              по району. */}
          <Suggest id="zone" name="zone" value={zone} onChange={setZone}
                   options={zonesOf(city.trim())} placeholder="Центр"
                   hint="Такого района нет в списке — сохраним как есть" />
        </div>
      </div>

      <div className="grid2">
        <div className="field s1">
          <label className="key" htmlFor="rooms">Комнат</label>
          <input id="rooms" name="rooms" type="text" inputMode="numeric"
                 defaultValue={draft?.rooms ?? ''} />
        </div>
        <div className="field s1">
          <label className="key" htmlFor="area">Площадь, м²</label>
          <input id="area" name="area" type="text" inputMode="decimal"
                 defaultValue={draft?.area ?? ''} />
        </div>
        <div className="field s1">
          <label className="key" htmlFor="floor">Этаж</label>
          <input id="floor" name="floor" type="text" inputMode="numeric"
                 defaultValue={draft?.floor ?? ''} />
        </div>
        <div className="field s1">
          <label className="key" htmlFor="floors_total">Этажей в доме</label>
          <input id="floors_total" name="floors_total" type="text" inputMode="numeric"
                 defaultValue={draft?.floors_total ?? ''} />
        </div>
      </div>

      {/* ── Поля для площадок ──────────────────────────────────
          Площадка не публикует объявление, если нет хотя бы одного
          обязательного поля. Поэтому они собраны отдельным блоком и
          подписаны: агент видит, чего не хватает, ещё в кабинете, а не
          узнаёт из отчёта площадки через сутки. */}
      <h3 className="form-part">Для площадок</h3>
      <p className="key">
        Без координат объявление не примет ни одна площадка. Остальное
        зависит от типа объекта.
      </p>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="latitude">Широта</label>
          <input id="latitude" name="latitude" type="text" inputMode="decimal"
                 defaultValue={draft?.latitude ?? ''} placeholder="42.819242" />
        </div>
        <div className="field">
          <label className="key" htmlFor="longitude">Долгота</label>
          <input id="longitude" name="longitude" type="text" inputMode="decimal"
                 defaultValue={draft?.longitude ?? ''} placeholder="74.619628" />
        </div>
      </div>

      <div className="grid2">
        <Pick name="region" label="Регион" values={REGION} value={draft?.region}
              hint="Пусто и город Бишкек — подставится «Чуйская область / Бишкек»." />
        <div className="field">
          <label className="key" htmlFor="house_number">Номер дома</label>
          <input id="house_number" name="house_number" type="text"
                 defaultValue={draft?.house_number ?? ''} placeholder="21/7" />
        </div>
      </div>

      {/* Район и микрорайон площадка принимает только для Бишкека. */}
      <div className="grid2">
        <Pick name="district" label="Район Бишкека" values={DISTRICT}
              value={draft?.district} />
        <div className="field">
          <label className="key" htmlFor="micro_district">Микрорайон</label>
          <input id="micro_district" name="micro_district" type="text"
                 defaultValue={draft?.micro_district ?? ''} placeholder="Асанбай" />
        </div>
      </div>

      <div className="grid2">
        {kind === 'flat' ? (
          <>
            <Pick name="building_type" label="Тип дома" values={BUILDING_TYPE}
                  value={draft?.building_type} hint="Без него квартиру не опубликуют." />
            <Pick name="serie" label="Серия" values={SERIE} value={draft?.serie}
                  hint="Без неё квартиру не опубликуют." />
          </>
        ) : null}

        {kind === 'house' || kind === 'townhouse' || kind === 'land' ? (
          <div className="field">
            <label className="key" htmlFor="land_area">Участок, соток</label>
            <input id="land_area" name="land_area" type="text" inputMode="decimal"
                   defaultValue={draft?.land_area ?? ''} />
            <p className="key">Без него дом и участок не опубликуют.</p>
          </div>
        ) : null}

        {kind === 'commercial' ? (
          <Pick name="commercial_type" label="Вид коммерции" values={COMMERCIAL_TYPE}
                value={draft?.commercial_type} hint="Без него объект не опубликуют." />
        ) : null}

        {kind === 'room' ? (
          <Pick name="room_location" label="Где комната" values={ROOM_LOCATION}
                value={draft?.room_location} hint="Без него комнату не опубликуют." />
        ) : null}

        {kind === 'garage' ? (
          <Pick name="parking_type" label="Паркинг или гараж" values={PARKING_TYPE}
                value={draft?.parking_type} hint="Без него объект не опубликуют." />
        ) : null}

        {dealType === 'rent' ? (
          <Pick name="rental_term" label="Срок аренды" values={RENTAL_TERM}
                value={draft?.rental_term} hint="Без него аренду не опубликуют." />
        ) : null}

        <div className="field s1">
          <label className="key" htmlFor="build_year">Год постройки</label>
          <input id="build_year" name="build_year" type="text" inputMode="numeric"
                 defaultValue={draft?.build_year ?? ''} placeholder="2023" />
        </div>
      </div>

      <div className="field">
        <label className="key" htmlFor="description">Описание</label>
        <textarea id="description" name="description" rows={4}
                  value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="actions">
          <button type="button" className="ghost" onClick={draftIt} disabled={drafting}>
            {drafting ? 'Пишу…' : 'Черновик по данным карточки'}
          </button>
        </div>
        <p className="key">
          Модель пишет только по заполненным полям и вашим заметкам в этом
          поле — ничего не придумывает. Прочитайте и поправьте: под текстом
          стоит ваше имя.
        </p>
        {draftError ? <p className="error">{draftError}</p> : null}
      </div>

      <PhotoUpload objectId={draft?.id ?? null} initial={photoList} />

      {mode === 'create' ? (
        <>
          <h2>Собственник</h2>
          <p className="key">
            Телефон виден вам, участникам активной сделки по объекту и администратору.
          </p>
          <div className="grid2">
            <div className="field">
              <label className="key" htmlFor="owner_name">Имя</label>
              <input id="owner_name" name="owner_name" type="text" placeholder="Орозов Нурлан" />
            </div>
            <div className="field">
              <label className="key" htmlFor="owner_phone">Телефон</label>
              <input id="owner_phone" name="owner_phone" type="tel" placeholder="+996 700 00 00 00" />
            </div>
          </div>

          <h2>Мандат</h2>
          <p className="key">
            Без активного мандата объект нельзя опубликовать. Можно оставить пустым
            и заключить договор позже — объект останется черновиком.
          </p>
          <div className="grid2">
            <div className="field">
              <label className="key" htmlFor="mandate_kind">Вид договора</label>
              <select id="mandate_kind" name="mandate_kind" defaultValue="">
                <option value="">без договора — черновик</option>
                <option value="exclusive">эксклюзив</option>
                <option value="non_exclusive">неэксклюзив</option>
              </select>
            </div>
            <div className="field s1">
              <label className="key" htmlFor="mandate_valid_to">Срок до</label>
              <input id="mandate_valid_to" name="mandate_valid_to" type="date" />
            </div>
            <div className="field s1">
              <label className="key" htmlFor="mandate_start_price">Стартовая цена</label>
              <input id="mandate_start_price" name="mandate_start_price" type="text"
                     inputMode="decimal" placeholder="как цена объекта" />
            </div>
            <div className="field s4">
              <label className="key" htmlFor="document_url">Ссылка на документ</label>
              <input id="document_url" name="document_url" type="url" />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" name="contract_confirmed" /> договор подтверждён документом
          </label>
        </>
      ) : null}

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Сохраняем…' : mode === 'create' ? 'Создать объект' : 'Сохранить'}
        </button>
        <Link className="btn ghostlink" href={draft?.id ? `/cabinet/objects/${draft.id}` : '/cabinet/objects'}>
          отмена
        </Link>
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
