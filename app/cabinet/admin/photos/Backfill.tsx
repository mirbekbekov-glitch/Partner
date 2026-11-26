'use client';

import { useState } from 'react';
import { thumbnailFrom } from '@/lib/photo-resize';
import { thumbKey } from '@/lib/photo-url';

/**
 * Пересчёт миниатюр.
 *
 * Работу делает эта страница, а не сервер, и это не обходной путь.
 * Миниатюру создаёт браузер — в Worker'е нет ни холста, ни кодировщика
 * картинок, а преобразование изображений у Cloudflare платное. Поэтому
 * страница скачивает снимок, уменьшает его у себя и отправляет готовое.
 *
 * По одному, последовательно. Десяток параллельных скачиваний
 * двухмегабайтных файлов забьёт канал и ничего не ускорит: узкое место —
 * сеть, а не процессор.
 *
 * Пропуск вместо остановки. Один нечитаемый файл не должен обрывать
 * пересчёт сотни остальных; что пропущено, видно в итоге.
 *
 * Закрыть вкладку посреди работы безопасно: каждая миниатюра
 * сохраняется сразу, и повторный запуск возьмёт только оставшиеся —
 * список строится из того, чего в хранилище нет.
 */
type Done = { ok: number; skipped: string[]; total: number };

export function Backfill() {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null); setDone(null);

    const result: Done = { ok: 0, skipped: [], total: 0 };

    try {
      let cursor: string | null = null;

      do {
        setStage('Ищем снимки без миниатюр…');

        const url = cursor
          ? `/api/photos/thumbs?cursor=${encodeURIComponent(cursor)}`
          : '/api/photos/thumbs';
        const page = await fetch(url);
        const data = await page.json() as {
          keys?: string[]; cursor?: string | null; error?: string;
        };

        if (!page.ok || !data.keys) {
          setError(data.error ?? 'Список не получен.');
          break;
        }

        result.total += data.keys.length;

        for (const key of data.keys) {
          setStage(`${result.ok + result.skipped.length + 1} из ${result.total}: ${key.split('/').pop()}`);

          // Объект зашит в ключ: objects/<id объекта>/<снимок>.
          const objectId = key.split('/')[1] ?? '';

          try {
            const file = await fetch(`/photos/${key}`);
            if (!file.ok) { result.skipped.push(key); continue; }

            const thumb = await thumbnailFrom(await file.blob());
            if (!thumb) { result.skipped.push(key); continue; }

            const body = new FormData();
            body.set('object_id', objectId);
            body.set('key', key);
            body.set('thumb', thumb, thumbKey(key).split('/').pop()!);

            const sent = await fetch('/api/photos/thumbs', { method: 'POST', body });
            if (sent.ok) result.ok++; else result.skipped.push(key);
          } catch {
            result.skipped.push(key);
          }
        }

        cursor = data.cursor ?? null;
      } while (cursor);

      setDone(result);
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <div className="stack">
      <button type="button" onClick={run} disabled={busy}>
        {busy ? 'Пересчитываем…' : 'Пересчитать миниатюры'}
      </button>

      {stage ? <p className="key">{stage}</p> : null}

      {done ? (
        <p className={done.skipped.length ? 'error' : 'key'}>
          {done.total === 0
            ? 'Снимков без миниатюр нет — пересчитывать нечего.'
            : `Сделано миниатюр: ${done.ok} из ${done.total}.`}
          {done.skipped.length
            ? ` Пропущено ${done.skipped.length}: файл не читается или браузер не смог его уменьшить. Эти снимки будут отдаваться полным размером — это медленнее, но не сломано.`
            : ''}
        </p>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
