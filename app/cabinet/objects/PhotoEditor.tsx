'use client';

import { useEffect, useRef, useState } from 'react';
import { fixLight } from '@/lib/photo-fix';
import type { PhotoEdit } from '@/lib/db/photo-edits';

/**
 * Обработка снимка: свет и стирание лишнего.
 *
 * ГРАНИЦА, которую держит этот экран. Стирать можно то, что уедет вместе
 * с жильцами: людей, личные вещи, документы, мусор, провода, сушилку с
 * бельём. Нельзя — то, что останется покупателю: трещины, плесень,
 * потёки, вид из окна. Первое — уважение к частной жизни, второе — обман
 * на показе, и отвечать за него агенту.
 *
 * Машина эту границу не проверит: отличить мешок мусора от пятна сырости
 * она не умеет. Поэтому здесь три вещи вместо запрета: правило написано
 * над кнопкой, оригинал хранится всегда и возвращается одним нажатием, а
 * объявление сообщает покупателю, что с кадра стирали предметы.
 *
 * Свет правится без модели — гистограммой и балансом белого. Это не
 * меняет квартиру: тёмный кадр и тот же кадр со светом показывают одну и
 * ту же комнату, — и пометки не требует.
 *
 * Модель получает только ВЫРЕЗАННЫЙ квадрат вокруг отмеченного места.
 * Целый снимок она перерисовала бы весь, и квартира перестала бы быть
 * собой.
 */

type Photo = { url: string; edit?: PhotoEdit };

/** Во сколько раз вырезать шире отмеченного: модели нужен контекст. */
const CONTEXT = 1.8;

export function PhotoEditor({
  objectId, photos,
}: {
  objectId: string;
  photos: Photo[];
}) {
  const [list, setList] = useState<Photo[]>(photos);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [erased, setErased] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLCanvasElement | null>(null);
  // Отметка: прямоугольник в координатах снимка, а не экрана.
  const mark = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const drawing = useRef(false);

  // Снимок грузится в свой холст полного размера: показываем мы его
  // уменьшенным, а сохранять надо в исходном качестве.
  useEffect(() => {
    if (!open) return;
    let alive = true;

    (async () => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = open;
      const loaded = await img.decode().then(() => true).catch(() => false);
      if (!alive) return;

      // Снимок не открылся — говорим об этом. Раньше здесь стоял молчащий
      // catch, и холст получался нулевого размера: экран открывался
      // пустым, а в консоли сыпались ошибки рисования.
      if (!loaded || img.naturalWidth === 0) {
        setError('Снимок не открылся. Обновите страницу и попробуйте снова.');
        image.current = null;
        return;
      }

      const full = document.createElement('canvas');
      full.width = img.naturalWidth;
      full.height = img.naturalHeight;
      full.getContext('2d')?.drawImage(img, 0, 0);
      image.current = full;
      mark.current = null;
      setDirty(false);
      setErased(false);
      setError(null);
      paint();
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Перерисовать экранный холст: снимок плюс отметка поверх. */
  function paint() {
    const full = image.current;
    const view = canvas.current;
    if (!full || !view) return;

    const scale = Math.min(1, 720 / full.width);
    view.width = Math.round(full.width * scale);
    view.height = Math.round(full.height * scale);

    const ctx = view.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(full, 0, 0, view.width, view.height);

    const m = mark.current;
    if (m) {
      ctx.save();
      ctx.fillStyle = 'rgba(200, 40, 40, .28)';
      ctx.strokeStyle = '#C82828';
      ctx.lineWidth = 2;
      const x = Math.min(m.x1, m.x2) * scale;
      const y = Math.min(m.y1, m.y2) * scale;
      const w = Math.abs(m.x2 - m.x1) * scale;
      const h = Math.abs(m.y2 - m.y1) * scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  /** Экранные координаты → координаты снимка. */
  function at(e: React.PointerEvent): { x: number; y: number } | null {
    const full = image.current;
    const view = canvas.current;
    if (!full || !view) return null;
    const box = view.getBoundingClientRect();
    const k = full.width / box.width;
    return { x: (e.clientX - box.left) * k, y: (e.clientY - box.top) * k };
  }

  function light() {
    const full = image.current;
    if (!full) return;
    const ctx = full.getContext('2d');
    if (!ctx) return;

    const data = ctx.getImageData(0, 0, full.width, full.height);
    const changed = fixLight(data.data);
    if (!changed) { setError('Свет и так ровный — править нечего.'); return; }

    ctx.putImageData(data, 0, 0);
    setDirty(true);
    setError(null);
    paint();
  }

  async function erase() {
    const full = image.current;
    const m = mark.current;
    if (!full || !m) { setError('Сначала обведите предмет.'); return; }

    setBusy('Стираем…');
    setError(null);

    // Квадрат вокруг отметки с запасом: модели нужен контекст, иначе она
    // дорисует стену, не похожую на соседнюю.
    const cx = (m.x1 + m.x2) / 2;
    const cy = (m.y1 + m.y2) / 2;
    const side = Math.min(
      full.width,
      full.height,
      Math.max(Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1)) * CONTEXT,
    );
    const x = Math.max(0, Math.min(full.width - side, cx - side / 2));
    const y = Math.max(0, Math.min(full.height - side, cy - side / 2));

    const patch = document.createElement('canvas');
    patch.width = 512;
    patch.height = 512;
    patch.getContext('2d')?.drawImage(full, x, y, side, side, 0, 0, 512, 512);

    const blob = await new Promise<Blob | null>((res) => patch.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) { setBusy(null); setError('Не получилось вырезать кусок.'); return; }

    const body = new FormData();
    body.set('what', 'erase');
    body.set('object_id', objectId);
    body.set('patch', blob, 'patch.jpg');

    try {
      const response = await fetch('/api/photo-edit', { method: 'POST', body });
      const data = await response.json() as { image?: string; error?: string };
      if (!response.ok || !data.image) {
        setError(data.error ?? 'Не получилось обработать.');
        setBusy(null);
        return;
      }

      const out = new Image();
      out.src = `data:image/jpeg;base64,${data.image}`;
      await out.decode();

      const ctx = full.getContext('2d');
      ctx?.drawImage(out, 0, 0, out.width, out.height, x, y, side, side);

      mark.current = null;
      setDirty(true);
      setErased(true);
      paint();
    } catch {
      setError('Связь прервалась.');
    }

    setBusy(null);
  }

  async function save() {
    const full = image.current;
    if (!full || !open) return;

    setBusy('Сохраняем…');
    const blob = await new Promise<Blob | null>((res) => full.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) { setBusy(null); setError('Не получилось собрать снимок.'); return; }

    const body = new FormData();
    body.set('what', 'save');
    body.set('object_id', objectId);
    body.set('original', open);
    body.set('file', blob, 'edited.jpg');
    body.set('erased', erased ? '1' : '0');

    const response = await fetch('/api/photo-edit', { method: 'POST', body });
    const data = await response.json() as PhotoEdit & { error?: string };

    if (!response.ok || !data.url) {
      setError(data.error ?? 'Не сохранилось.');
      setBusy(null);
      return;
    }

    setList((prev) => prev.map((p) => (p.url === open ? { url: data.url, edit: data } : p)));
    setOpen(null);
    setBusy(null);
  }

  async function restore(url: string) {
    const body = new FormData();
    body.set('what', 'restore');
    body.set('object_id', objectId);
    body.set('url', url);

    const response = await fetch('/api/photo-edit', { method: 'POST', body });
    if (!response.ok) { setError('Не получилось вернуть оригинал.'); return; }

    setList((prev) => prev.map((p) => (
      p.url === url && p.edit ? { url: p.edit.original } : p
    )));
  }

  if (list.length === 0) {
    return <p className="key">Снимков пока нет — обрабатывать нечего.</p>;
  }

  return (
    <div className="shots">
      <ul className="shots-list">
        {list.map((p) => (
          <li key={p.url}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt="" loading="lazy" />
            <div className="shots-act">
              <button type="button" className="btn ghostlink" onClick={() => setOpen(p.url)}>
                Обработать
              </button>
              {p.edit ? (
                <>
                  <button type="button" className="btn ghostlink" onClick={() => restore(p.url)}>
                    Вернуть оригинал
                  </button>
                  {p.edit.erased ? <span className="tag">стёрты предметы</span> : null}
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {open ? (
        <div className="shots-edit">
          <p className="key">
            Обведите предмет и нажмите «Стереть». Стирать можно личные
            вещи, людей, документы, мусор, провода — то, что уедет вместе
            с жильцами. <b>Трещины, плесень, потёки и вид из окна стирать
            нельзя</b>: покупатель увидит их на показе, и отвечать
            придётся вам. Оригинал сохраняется и возвращается одним
            нажатием.
          </p>

          <canvas
            ref={canvas}
            className="shots-canvas"
            onPointerDown={(e) => {
              const p = at(e);
              if (!p) return;
              drawing.current = true;
              mark.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
              (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drawing.current || !mark.current) return;
              const p = at(e);
              if (!p) return;
              mark.current = { ...mark.current, x2: p.x, y2: p.y };
              paint();
            }}
            onPointerUp={() => { drawing.current = false; }}
          />

          <div className="shots-buttons">
            <button type="button" className="btn ghostlink" onClick={light} disabled={!!busy}>
              Поправить свет
            </button>
            <button type="button" className="btn ghostlink" onClick={erase} disabled={!!busy}>
              Стереть отмеченное
            </button>
            <button type="button" className="btn" onClick={save} disabled={!!busy || !dirty}>
              Сохранить
            </button>
            <button
              type="button"
              className="btn ghostlink"
              onClick={() => { setOpen(null); setError(null); }}
              disabled={!!busy}
            >
              Отмена
            </button>
          </div>

          {busy ? <p className="key">{busy}</p> : null}
          {error ? <p className="warn">{error}</p> : null}
          {erased ? (
            <p className="key">
              В объявлении появится подпись, что с фотографий убраны предметы.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
