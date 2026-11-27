'use client';

import { useRef, useState } from 'react';
import { preparePanorama, size } from '@/lib/photo-resize';
import type { Panorama } from '@/lib/db/panoramas';

/**
 * Панорамы объекта: загрузка и подписи комнат.
 *
 * Рядом с загрузкой стоит инструкция, и это не украшение. Тур собирается
 * из того, что снял агент, и ни один алгоритм не починит кадр, снятый с
 * шага или против окна. Инструкция здесь, а не в отдельной справке,
 * потому что читают её ровно в ту секунду, когда собираются снимать.
 *
 * Панорама сжимается в браузере до 5120 точек по длинной стороне и
 * уходит сразу, по одной: с телефона на мобильном интернете разница
 * между двадцатью мегабайтами и двумя — это разница между «висит» и
 * «готово».
 */

export function PanoramaUpload({
  objectId, initial,
}: {
  objectId: string | null;
  initial: Panorama[];
}) {
  const [list, setList] = useState<Panorama[]>(initial);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: FileList) {
    if (!objectId) return;
    setError(null);
    setBusy(true);

    for (const file of Array.from(files)) {
      setStage(`${file.name}: сжимаем…`);
      const ready = await preparePanorama(file);

      const body = new FormData();
      body.set('object_id', objectId);
      body.set('file', ready.full, file.name);
      body.set('w', String(ready.width));
      body.set('h', String(ready.height));
      body.set('room', '');

      setStage(`${file.name}: отправляем ${size(ready.after)} вместо ${size(ready.before)}`);

      try {
        const response = await fetch('/api/panoramas', { method: 'POST', body });
        const data = await response.json() as Panorama & { error?: string };
        if (!response.ok || !data.url) {
          setError(`${file.name}: ${data.error ?? 'не загрузилась'}`);
          continue;
        }
        setList((prev) => [...prev, data]);
      } catch {
        setError(`${file.name}: связь прервалась`);
      }
    }

    setBusy(false);
    setStage(null);
    if (input.current) input.current.value = '';
  }

  async function rename(key: string, room: string) {
    setList((prev) => prev.map((p) => (p.key === key ? { ...p, room } : p)));
    if (!objectId) return;
    await fetch('/api/panoramas', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_id: objectId, key, room }),
    }).catch(() => undefined);
  }

  async function remove(key: string) {
    setList((prev) => prev.filter((p) => p.key !== key));
    if (!objectId) return;
    await fetch('/api/panoramas', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_id: objectId, key }),
    }).catch(() => undefined);
  }

  return (
    <div className="field pano">
      <span className="key">Панорамы для тура</span>

      {/* Инструкция свёрнута, но на виду: её читают перед съёмкой, а не
          ищут потом в справке. */}
      <details className="more pano-how">
        <summary>Как снимать, чтобы тур получился</summary>
        <ol className="pano-steps">
          <li>
            Снимайте режимом <b>«Панорама»</b> на телефоне. Нужен полный
            оборот — 360°, до той же точки, с которой начали.
          </li>
          <li>
            Встаньте <b>в центре комнаты</b> и поворачивайтесь вокруг себя,
            не делая шагов. Шаг в сторону — и панорама «переломится».
          </li>
          <li>
            Телефон вертикально, на уровне груди, поворот медленный и
            ровный, без наклонов.
          </li>
          <li>
            Шторы открыть, свет включить. <b>Не снимать против окна</b>:
            комната уйдёт в темноту.
          </li>
          <li>
            По одной панораме на комнату, плюс прихожая и вид с балкона.
            Подпишите каждую — подпись видна покупателю.
          </li>
          <li>
            Уберите личные вещи и документы, не попадайте в кадр сами.
          </li>
        </ol>
        <p className="key">
          Нужна настоящая сфера с потолком и полом — снимите бесплатным
          приложением Google Street View, режим «Фотосфера». Обычная
          панорама телефона тоже подойдёт: тур покажет её полосой по кругу.
        </p>
      </details>

      {objectId ? (
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      ) : (
        <p className="key">
          Панорамы добавляются после сохранения: их нужно к чему привязать.
        </p>
      )}

      {stage ? <p className="key">{stage}</p> : null}
      {error ? <p className="warn">{error}</p> : null}

      {list.length > 0 ? (
        <ul className="pano-list">
          {list.map((p, i) => (
            <li key={p.key} className="pano-item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" loading="lazy" />
              <input
                type="text"
                defaultValue={p.room}
                placeholder={`Комната ${i + 1}`}
                onBlur={(e) => rename(p.key, e.target.value)}
              />
              <button type="button" className="btn ghostlink" onClick={() => remove(p.key)}>
                Убрать
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
