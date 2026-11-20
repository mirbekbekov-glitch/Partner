'use client';

import { useActionState } from 'react';
import { saveProfile, type ProfileResult } from './actions';

export function ProfileForm({
  fullName,
  phone,
  email,
  hint,
}: {
  fullName: string;
  phone: string | null;
  email: string | null;
  hint?: string;
}) {
  const [state, formAction, pending] = useActionState<ProfileResult, FormData>(
    async (_prev, fd) => saveProfile(fd),
    { error: null, saved: false },
  );

  // После первого входа в имени стоит почта: подсказываем вписать настоящее.
  const nameIsEmail = fullName === email;

  return (
    <form action={formAction} className="stack">
      <div className="field">
        <label className="key" htmlFor="full_name">
          Имя и фамилия
        </label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          required
          defaultValue={nameIsEmail ? '' : fullName}
          placeholder={nameIsEmail ? 'Как вас записать' : undefined}
          autoComplete="name"
        />
        {nameIsEmail ? (
          <p className="key">
            Сейчас вместо имени стоит почта. Админ видит эту строку в списке
            агентов — впишите настоящее имя, чтобы заявку можно было опознать.
          </p>
        ) : null}
      </div>

      <div className="field">
        <label className="key" htmlFor="phone">
          Телефон
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={phone ?? ''}
          placeholder="+996 700 00 00 00"
          autoComplete="tel"
        />
        <p className="key">Не обязателен. Коллегам виден, клиентам — нет.</p>
      </div>

      <div className="field">
        <span className="key">Почта</span>
        <p>
          {email ?? '—'} <span className="key">— меняется только входом</span>
        </p>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {state.saved && !state.error ? <span className="key">Сохранено</span> : null}
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
      {hint ? <p className="key">{hint}</p> : null}
    </form>
  );
}
