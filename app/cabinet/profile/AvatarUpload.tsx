'use client';

import { useRef, useState } from 'react';
import { prepare, size } from '@/lib/photo-resize';

/**
 * Аватарка агента.
 *
 * Сжимается в браузере тем же способом, что и снимки объектов: аватарка
 * с телефона — это те же мегабайты, а показывается она размером с
 * ноготь. Берётся МИНИАТЮРА, не полный снимок: для лица 640 точек с
 * избытком, и это ещё в несколько раз меньше.
 *
 * Адрес после загрузки получает метку времени — не для сервера, а для
 * браузера: ключ аватарки постоянный, и без метки на экране осталась бы
 * прежняя картинка из кеша, а человек решил бы, что загрузка не прошла.
 */
export function AvatarUpload({ initial }: { initial: string | null }) {
  const [url, setUrl] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true); setError(null);

    const ready = await prepare(file);
    const body = new FormData();
    body.set('file', ready.thumb ?? ready.full, file.name);

    try {
      const response = await fetch('/api/avatar', { method: 'POST', body });
      const data = await response.json() as { url?: string; error?: string };

      if (!response.ok || !data.url) setError(data.error ?? 'Не загрузилась');
      else setUrl(`${data.url}?v=${Date.now()}`);
    } catch {
      setError('Связь прервалась');
    }

    setBusy(false);
    if (input.current) input.current.value = '';
  }

  async function drop() {
    setBusy(true); setError(null);
    await fetch('/api/avatar', { method: 'DELETE' }).catch(() => undefined);
    setUrl(null);
    setBusy(false);
  }

  return (
    <div className="field">
      <label className="key">Фотография</label>

      <div className="inline">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="avatar" width={72} height={72} />
        ) : (
          <span className="avatar none" aria-hidden="true" />
        )}

        <div className="stack">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          {url ? (
            <button type="button" className="ghost" onClick={drop} disabled={busy}>
              убрать
            </button>
          ) : null}
        </div>
      </div>

      <p className="key">
        {busy
          ? 'Загружаем…'
          : 'Клиент видит её на карточке объекта. Снимок сжимается в браузере — '
            + 'отправлять полный файл с телефона не нужно.'}
      </p>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
