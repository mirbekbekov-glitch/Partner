'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { FormResult } from './form-actions';

export type RequirementDraft = {
  id?: string;
  deal_type: string;
  budget_min: number | null;
  budget_max: number | null;
  zones: string[] | null;
  rooms: number[] | null;
  deadline: string | null;
  requirements_text: string | null;
  status?: string;
  closed_reason?: string | null;
};

// «В сделке» в списке нет: он ставится созданием сделки из подбора
// (инвариант 2), и база такую правку вручную отклоняет.
const STATUSES: [string, string][] = [
  ['new', 'новая'],
  ['qualified', 'квалифицирована'],
  ['in_showings', 'в показах'],
  ['closed', 'закрыта'],
  ['lost', 'отвал'],
];

export function RequirementForm({
  action,
  draft,
  mode,
}: {
  action: (fd: FormData) => Promise<FormResult>;
  draft?: RequirementDraft;
  mode: 'create' | 'edit';
}) {
  const [state, formAction, pending] = useActionState<FormResult, FormData>(
    async (_prev, fd) => action(fd),
    { error: null },
  );

  return (
    <form action={formAction} className="stack">
      {draft?.id ? <input type="hidden" name="id" value={draft.id} /> : null}

      <div className="field">
        <label className="key" htmlFor="deal_type">Что нужно</label>
        <select id="deal_type" name="deal_type" required defaultValue={draft?.deal_type ?? 'sale'}>
          <option value="sale">купить</option>
          <option value="rent">снять</option>
        </select>
      </div>

      {mode === 'create' ? (
        <>
          <h2>Клиент</h2>
          <p className="key">
            Телефон виден вам, участникам активной сделки и администратору.
          </p>
          <div className="grid2">
            <div className="field">
              <label className="key" htmlFor="client_name">Имя</label>
              <input id="client_name" name="client_name" type="text" required
                     placeholder="Жумаев Азамат" />
            </div>
            <div className="field">
              <label className="key" htmlFor="client_phone">Телефон</label>
              <input id="client_phone" name="client_phone" type="tel"
                     placeholder="+996 700 00 00 00" />
            </div>
          </div>
          <p className="key">
            Если клиент уже есть в базе — не заводите второго: один человек, одна запись.
            Заведите ему вторую потребность с его карточки.
          </p>
        </>
      ) : null}

      <h2>Условия</h2>
      <div className="grid2">
        <div className="field s1">
          <label className="key" htmlFor="budget_min">Бюджет от</label>
          <input id="budget_min" name="budget_min" type="text" inputMode="decimal"
                 defaultValue={draft?.budget_min ?? ''} />
        </div>
        <div className="field s1">
          <label className="key" htmlFor="budget_max">Бюджет до</label>
          <input id="budget_max" name="budget_max" type="text" inputMode="decimal"
                 defaultValue={draft?.budget_max ?? ''} />
        </div>
        <div className="field">
          <label className="key" htmlFor="zones">Зоны</label>
          <input id="zones" name="zones" type="text"
                 defaultValue={(draft?.zones ?? []).join(', ')} placeholder="Центр, Юг" />
          <p className="key">Через запятую.</p>
        </div>
        <div className="field s1">
          <label className="key" htmlFor="rooms">Комнат</label>
          <input id="rooms" name="rooms" type="text"
                 defaultValue={(draft?.rooms ?? []).join(', ')} placeholder="2, 3" />
          <p className="key">Через запятую.</p>
        </div>
        <div className="field s1">
          <label className="key" htmlFor="deadline">Срок</label>
          <input id="deadline" name="deadline" type="date" defaultValue={draft?.deadline ?? ''} />
        </div>
        {mode === 'edit' ? (
          <div className="field">
            <label className="key" htmlFor="status">Статус</label>
            <select id="status" name="status" defaultValue={draft?.status ?? 'new'}>
              {STATUSES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              {draft?.status === 'in_deal' ? (
                <option value="in_deal">в сделке</option>
              ) : null}
            </select>
            <p className="key">
              «В сделке» ставится созданием сделки из подбора, вручную — нет.
            </p>
          </div>
        ) : null}
      </div>

      <div className="field">
        <label className="key" htmlFor="requirements_text">Требования</label>
        <textarea id="requirements_text" name="requirements_text" rows={3}
                  defaultValue={draft?.requirements_text ?? ''}
                  placeholder="Не первый и не последний этаж, своя парковка" />
      </div>

      {mode === 'edit' ? (
        <div className="field">
          <label className="key" htmlFor="closed_reason">Причина закрытия или отвала</label>
          <input id="closed_reason" name="closed_reason" type="text"
                 defaultValue={draft?.closed_reason ?? ''} />
        </div>
      ) : null}

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Сохраняем…' : mode === 'create' ? 'Создать потребность' : 'Сохранить'}
        </button>
        <Link className="key"
              href={draft?.id ? `/cabinet/requirements/${draft.id}` : '/cabinet/requirements'}>
          отмена
        </Link>
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
