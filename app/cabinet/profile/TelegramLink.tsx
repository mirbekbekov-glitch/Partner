'use client';

import { useState } from 'react';
import { dropTelegram, requestTelegramLink } from './actions';

/**
 * Привязка Telegram.
 *
 * Ссылка ПОКАЗЫВАЕТСЯ, а не открывается сама. Кабинет человек обычно
 * держит на компьютере, а Telegram стоит на телефоне: перенаправление
 * увело бы в браузер, где бота нет. Поэтому ссылку видно, её можно
 * нажать здесь же или открыть на телефоне.
 *
 * Срок кода короткий и назван прямо: код уходит в чат, а протухшая
 * ссылка без объяснения выглядит поломкой.
 */
export function TelegramLink({ linked }: { linked: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true); setError(null);
    const r = await requestTelegramLink();
    setBusy(false);
    if (r.error) setError(r.error); else setUrl(r.url);
  }

  async function drop() {
    setBusy(true); setError(null);
    const r = await dropTelegram();
    setBusy(false);
    if (r.error) setError(r.error);
  }

  if (linked) {
    return (
      <div className="stack">
        <p className="key">
          Telegram привязан ({linked}) — напоминания о задачах и показах придут туда.
        </p>
        <button type="button" className="ghost" onClick={drop} disabled={busy}>
          {busy ? 'Отвязываем…' : 'Отвязать'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="stack">
      {url ? (
        <>
          <p>
            Откройте ссылку и нажмите в боте «Start» — он сам определит ваш Telegram.
          </p>
          <p><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
          <p className="key">
            Ссылка действует 10 минут и срабатывает один раз. Открыть можно и на
            телефоне — просто наберите этот адрес.
          </p>
        </>
      ) : (
        <button type="button" onClick={ask} disabled={busy}>
          {busy ? 'Готовим ссылку…' : 'Привязать Telegram'}
        </button>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
