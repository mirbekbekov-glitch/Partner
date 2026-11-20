'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Вход по ссылке на почту (Supabase magic link).
 *
 * Пароля нет сознательно: нет ни его хранения, ни восстановления, ни экранов
 * смены — меньше поверхности и меньше кода. Если понадобится пароль, это
 * signInWithPassword плюс экран восстановления.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState('sending');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    if (error) {
      setError(error.message);
      setState('idle');
      return;
    }
    setState('sent');
  }

  if (state === 'sent') {
    return (
      <div className="card">
        <p>
          Ссылка для входа отправлена на <strong>{email}</strong>.
        </p>
        <p className="key">
          Откройте её на этом же устройстве. Ссылка одноразовая и действует
          ограниченное время.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <label className="key" htmlFor="email">
          Рабочая почта
        </label>
      </div>
      <div className="inline" style={{ marginTop: 6 }}>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="agent@example.kg"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <button type="submit" disabled={state === 'sending'}>
          {state === 'sending' ? 'Отправляем…' : 'Получить ссылку'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
