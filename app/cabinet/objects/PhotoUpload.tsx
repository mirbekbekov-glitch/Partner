'use client';

import { useRef, useState } from 'react';
import { prepare, size } from '@/lib/photo-resize';
import { thumbOf } from '@/lib/photo-url';

/**
 * Загрузка снимков объекта.
 *
 * Снимки уходят в хранилище сразу, по одному, а не вместе с формой. Так
 * сделано потому, что агент заводит объект с телефона, и ждать отправки
 * десяти снимков, прежде чем увидеть хоть один, — это ощущение зависшей
 * страницы. Каждый снимок появляется в списке, как только долетел.
 *
 * Поле со ссылками остаётся рядом: часть снимков по-прежнему приходит
 * ссылками от собственника, и отбирать эту возможность незачем.
 *
 * Порядок снимков — порядок в списке: первый становится обложкой в
 * каталоге. Поэтому у каждого есть стрелка «вверх».
 *
 * Сжатие происходит ЗДЕСЬ, до отправки. Снимок с телефона — это восемь
 * мегабайт, и отправлять их, чтобы потом показывать посетителю картинку
 * шириной в тысячу точек, незачем. Выигрывает прежде всего сам агент: он
 * загружает объект с телефона, часто с мобильного интернета, и разница
 * между восемью мегабайтами и четырьмястами килобайтами — это разница
 * между «висит» и «готово».
 *
 * Вместе со снимком уходит миниатюра для списка. Делать её на сервере
 * нечем: преобразование изображений у Cloudflare — платная услуга, а в
 * Worker'е нет библиотеки изображений.
 */
type Photo = { url: string; key?: string };

export function PhotoUpload({
  objectId,
  initial,
}: {
  objectId: string | null;
  initial: string[];
}) {
  const [photos, setPhotos] = useState<Photo[]>(initial.map((url) => ({ url })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: FileList) {
    if (!objectId) return;
    setError(null);
    setBusy(true);

    // По одному, а не разом: Worker принимает тело ограниченного размера,
    // и десять снимков по пять мегабайт одним запросом в него не влезут.
    for (const file of Array.from(files)) {
      setStage(`${file.name}: сжимаем…`);

      // Сжатие идёт до отправки, и его видно: на телефоне большой снимок
      // обрабатывается заметную долю секунды, и без подписи это выглядит
      // как подвисшая страница.
      const ready = await prepare(file);

      const body = new FormData();
      body.set('object_id', objectId);
      body.set('file', ready.full, file.name);
      if (ready.thumb) body.set('thumb', ready.thumb, 'thumb.webp');

      setStage(
        ready.after < ready.before
          ? `${file.name}: отправляем ${size(ready.after)} вместо ${size(ready.before)}`
          : `${file.name}: отправляем ${size(ready.after)}`,
      );

      try {
        const response = await fetch('/api/photos', { method: 'POST', body });
        const data = await response.json() as { url?: string; key?: string; error?: string };

        if (!response.ok || !data.url) {
          // Имя файла в сообщении: при десяти снимках иначе непонятно,
          // какой именно не прошёл.
          setError(`${file.name}: ${data.error ?? 'не загрузился'}`);
          continue;
        }
        setPhotos((prev) => [...prev, { url: data.url!, key: data.key }]);
      } catch {
        setError(`${file.name}: связь прервалась`);
      }
    }

    setBusy(false);
    setStage(null);
    if (input.current) input.current.value = '';
  }

  async function remove(index: number) {
    const photo = photos[index];
    setPhotos((prev) => prev.filter((_, i) => i !== index));

    // Ссылку просто убираем из списка — файл не наш. Свой снимок удаляем
    // и из хранилища: иначе оно копит то, чего никто не видит.
    if (photo.key && objectId) {
      await fetch('/api/photos', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ object_id: objectId, key: photo.key }),
      }).catch(() => undefined);
    }
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setPhotos((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  return (
    <div className="field">
      {/* Значение уходит в форму скрытым полем: сервер принимает тот же
          список строк, что и раньше, и ничего про загрузку не знает. */}
      <input type="hidden" name="photos" value={photos.map((p) => p.url).join('\n')} />

      <label className="key">Фотографии</label>

      {photos.length > 0 ? (
        <ul className="photolist">
          {photos.map((p, i) => (
            <li key={p.url}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* В списке — миниатюра. Десяток полных снимков по
                  две тысячи точек здесь не нужен никому: каждый
                  отрисовывается размером с ноготь. */}
              <img src={thumbOf(p.url)} alt="" loading="lazy" />
              <span className="key">{i === 0 ? 'обложка' : `${i + 1}`}</span>
              <button type="button" onClick={() => moveUp(i)} disabled={i === 0}>
                вверх
              </button>
              <button type="button" onClick={() => remove(i)}>убрать</button>
            </li>
          ))}
        </ul>
      ) : null}

      {objectId ? (
        <>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            multiple
            disabled={busy}
            onChange={(e) => e.target.files && upload(e.target.files)}
          />
          <p className="key">
            {busy
              ? (stage ?? 'Загружаем…')
              : 'JPEG, PNG, WebP или AVIF. Снимки сжимаются в браузере — '
                + 'отправлять полный файл с телефона не нужно. '
                + 'Первый снимок — обложка в каталоге.'}
          </p>
        </>
      ) : (
        <p className="key">
          Снимки загружаются после сохранения: файлу нужен объект, к которому
          он относится. Сохраните карточку и вернитесь к правке.
        </p>
      )}

      <details className="more">
        <summary>Добавить ссылкой</summary>
        <p className="key">
          Если снимок уже где-то лежит. Такая ссылка живёт чужой жизнью: хостинг
          закроется — в объявлении останется пустое место.
        </p>
        <LinkAdder onAdd={(url) => setPhotos((prev) => [...prev, { url }])} />
      </details>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** Поле для ссылки. Отдельно, чтобы не плодить состояние в основном компоненте. */
function LinkAdder({ onAdd }: { onAdd: (url: string) => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="inline">
      <input
        type="url"
        aria-label="Ссылка на снимок"
        placeholder="https://…/1.jpg"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          const url = value.trim();
          if (/^https?:\/\//i.test(url)) { onAdd(url); setValue(''); }
        }}
      >
        Добавить
      </button>
    </div>
  );
}
