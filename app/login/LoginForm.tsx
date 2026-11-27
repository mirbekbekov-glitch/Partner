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
      <div className="auth-sent">
        <p>
          Если такая почта заведена, ссылка для входа отправлена на{' '}
          <strong>{state.email}</strong>.
        </p>
        <p className="auth-hint">
          Ссылка одноразовая и действует 15 минут. Откройте её на этом же
          устройстве.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="email">Рабочая почта</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="agent@example.kg"
        defaultValue={state?.email ?? ''}
      />
      {/* Кнопка во всю ширину и под полем, а не сбоку: рядом они
          срастались в одну полосу, и на телефоне кнопка оказывалась уже
          подписи на ней. */}
      <button type="submit" disabled={pending}>
        {pending ? 'Отправляем…' : 'Получить ссылку'}
      </button>
      {state?.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
