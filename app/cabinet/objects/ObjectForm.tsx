'use client';

import Link from 'next/link';
import { useActionState, useRef, useState, useTransition } from 'react';
import type { FormResult } from './form-actions';
import { draftDescription } from './form-actions';
import { PhotoUpload } from './PhotoUpload';

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
};

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
          <select id="deal_type" name="deal_type" required defaultValue={draft?.deal_type ?? 'sale'}>
            <option value="sale">продажа</option>
            <option value="rent">аренда</option>
          </select>
        </div>
        <div className="field">
          <label className="key" htmlFor="kind">Тип</label>
          <select id="kind" name="kind" required defaultValue={draft?.kind ?? 'flat'}>
            {KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="key" htmlFor="address">Адрес</label>
        <input id="address" name="address" type="text" required
               defaultValue={draft?.address ?? ''} placeholder="Чүй 120, кв. 5" />
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
          <input id="city" name="city" type="text"
                 defaultValue={draft?.city ?? 'Бишкек'} placeholder="Бишкек" />
        </div>
        <div className="field">
          <label className="key" htmlFor="zone">Зона</label>
          <input id="zone" name="zone" type="text" defaultValue={draft?.zone ?? ''}
                 placeholder="Центр" />
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="rooms">Комнат</label>
          <input id="rooms" name="rooms" type="text" inputMode="numeric"
                 defaultValue={draft?.rooms ?? ''} />
        </div>
        <div className="field">
          <label className="key" htmlFor="area">Площадь, м²</label>
          <input id="area" name="area" type="text" inputMode="decimal"
                 defaultValue={draft?.area ?? ''} />
        </div>
        <div className="field">
          <label className="key" htmlFor="floor">Этаж</label>
          <input id="floor" name="floor" type="text" inputMode="numeric"
                 defaultValue={draft?.floor ?? ''} />
        </div>
        <div className="field">
          <label className="key" htmlFor="floors_total">Этажей в доме</label>
          <input id="floors_total" name="floors_total" type="text" inputMode="numeric"
                 defaultValue={draft?.floors_total ?? ''} />
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
            <div className="field">
              <label className="key" htmlFor="mandate_valid_to">Срок до</label>
              <input id="mandate_valid_to" name="mandate_valid_to" type="date" />
            </div>
            <div className="field">
              <label className="key" htmlFor="mandate_start_price">Стартовая цена</label>
              <input id="mandate_start_price" name="mandate_start_price" type="text"
                     inputMode="decimal" placeholder="как цена объекта" />
            </div>
            <div className="field">
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
        <Link className="key" href={draft?.id ? `/cabinet/objects/${draft.id}` : '/cabinet/objects'}>
          отмена
        </Link>
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
