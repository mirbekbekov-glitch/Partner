'use client';

import { useActionState } from 'react';
import { requestLoginLink, type LoginState } from './actions';

/**
 * Вход по ссылке на почту.
 *
 * Пароля нет сознательно: нет ни его хранения, ни восстановления, ни
 * экранов смены — меньше поверхности и меньше кода. Восстановление пароля
 * всё равно шло бы через почту, то есть почта осталась бы ключом, только
 * с лишним звеном.
 *
 * Форма работает без JavaScript: useActionState отправляет её обычным
 * POST. Раньше отправка шла из браузера прямо в Supabase, и без скриптов
 * кнопка была мёртвой.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState | null, FormData>(
    requestLoginLink,
    null,
  );

  if (state?.sent) {
    return (
      <div className="card">
        <p>
          Если такая почта заведена, ссылка для входа отправлена на{' '}
          <strong>{state.email}</strong>.
        </p>
        <p className="key">
          Ссылка одноразовая и действует 15 минут. Откройте её на этом же
          устройстве.
        </p>
      </div>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <div className="row">
        <label className="key" htmlFor="email">Рабочая почта</label>
      </div>
      <div className="inline" style={{ marginTop: 6 }}>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="agent@example.kg"
          defaultValue={state?.email ?? ''}
          style={{ minWidth: 240 }}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Отправляем…' : 'Получить ссылку'}
        </button>
      </div>
      {state?.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
