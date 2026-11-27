'use client';

import { useEffect, useRef, useState } from 'react';
import 'pannellum/build/pannellum.css';
import type { Link, Panorama } from '@/lib/db/panoramas';
import { roomName, vaovOf } from '../../Tour360';

/**
 * Расстановка переходов между комнатами.
 *
 * Как это делается руками. Агент крутит панораму, наводит середину
 * экрана на дверь и выбирает, куда эта дверь ведёт. Наводить, а не
 * тыкать: попасть пальцем в дверь на телефоне трудно, а повернуть
 * панораму так, чтобы дверь оказалась в центре, — легко, и промахнуться
 * тут не в чем.
 *
 * Точка хранится в градусах — поворот и наклон, — а не в пикселях:
 * панорама круглая, и пиксели пришлось бы пересчитывать при каждой
 * смене размера снимка.
 *
 * Редактор живёт в кабинете и грузит тот же просмотрщик, что и витрина:
 * агент видит ровно то, что увидит покупатель, а не схему со стрелками.
 */

type Viewer = {
  destroy: () => void;
  getYaw: () => number;
  getPitch: () => number;
  setYaw: (v: number) => void;
  setPitch: (v: number) => void;
};

type Pannellum = { viewer: (el: HTMLElement, c: Record<string, unknown>) => Viewer };

export function TourEditor({
  objectId, panoramas,
}: {
  objectId: string;
  panoramas: Panorama[];
}) {
  const [list, setList] = useState<Panorama[]>(panoramas);
  const [at, setAt] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  // Куда агент смотрел до пересборки просмотрщика. Без этого каждая
  // поставленная точка сбрасывала бы вид в начало, и вторую дверь
  // пришлось бы искать заново.
  const look = useRef<{ key: string; yaw: number; pitch: number } | null>(null);

  const here = list[at];
  const others = list.filter((p) => p.key !== here?.key);

  useEffect(() => {
    if (!here) return;
    let alive = true;

    (async () => {
      try {
        await import('pannellum/build/pannellum.js');
        const lib = (window as unknown as { pannellum?: Pannellum }).pannellum;
        if (!alive || !lib || !box.current) {
          if (alive && !lib) setFailed(true);
          return;
        }

        if (viewer.current) {
          look.current = {
            key: here.key,
            yaw: viewer.current.getYaw(),
            pitch: viewer.current.getPitch(),
          };
          viewer.current.destroy();
        }

        const back = look.current?.key === here.key ? look.current : null;

        viewer.current = lib.viewer(box.current, {
          type: 'equirectangular',
          panorama: here.url,
          autoLoad: true,
          haov: 360,
          vaov: vaovOf(here.w, here.h),
          hfov: 100,
          yaw: back?.yaw ?? 0,
          pitch: back?.pitch ?? 0,
          // Уже расставленные переходы видны сразу: агент правит тур, а
          // не вспоминает, что он там наставил в прошлый раз.
          hotSpots: (here.links ?? []).map((l) => ({
            pitch: l.pitch,
            yaw: l.yaw,
            type: 'info',
            text: roomName(
              list.find((x) => x.key === l.to)?.room ?? '',
              list.findIndex((x) => x.key === l.to),
            ),
          })),
        });
      } catch {
        if (alive) setFailed(true);
      }
    })();

    return () => { alive = false; viewer.current?.destroy(); viewer.current = null; };
  }, [here, list]);

  async function save(key: string, links: Link[]) {
    setList((prev) => prev.map((p) => (p.key === key ? { ...p, links } : p)));
    setSaved(null);

    const response = await fetch('/api/panoramas', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_id: objectId, key, links }),
    }).catch(() => null);

    setSaved(response?.ok ? 'Сохранено' : 'Не сохранилось — попробуйте ещё раз');
  }

  function addLink(to: string) {
    if (!here || !viewer.current) return;
    // Точка берётся из середины экрана: туда агент и навёл.
    const yaw = viewer.current.getYaw();
    const pitch = viewer.current.getPitch();
    save(here.key, [...(here.links ?? []), { to, yaw, pitch }]);
  }

  if (list.length < 2) {
    return (
      <p className="key">
        Переходы появятся, когда панорам станет две и больше: ходить пока
        некуда.
      </p>
    );
  }

  return (
    <div className="tour-edit">
      <div className="tour-rooms">
        {list.map((p, i) => (
          <button
            key={p.key}
            type="button"
            className="tour-room"
            aria-current={i === at ? 'true' : undefined}
            onClick={() => setAt(i)}
          >
            {roomName(p.room, i)}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="warn">Просмотрщик не загрузился — переходы не расставить.</p>
      ) : (
        <>
          {/* Перекрестие — СОСЕД просмотрщика, а не его ребёнок:
              Pannellum чистит содержимое своего контейнера, и вложенный
              крест исчезал при первой же отрисовке. */}
          <div className="tour-edit-wrap">
            <div className="tour-box tour-edit-box" ref={box} />
            <span className="tour-aim" aria-hidden="true" />
          </div>

          <p className="key">
            Поверните панораму так, чтобы дверь оказалась в перекрестии,
            и нажмите комнату, куда она ведёт.
          </p>

          <div className="tour-targets">
            {others.map((p) => (
              <button
                key={p.key}
                type="button"
                className="btn ghostlink"
                onClick={() => addLink(p.key)}
              >
                → {roomName(p.room, list.indexOf(p))}
              </button>
            ))}
          </div>
        </>
      )}

      {here && (here.links ?? []).length > 0 ? (
        <ul className="tour-links">
          {(here.links ?? []).map((l, i) => (
            <li key={`${l.to}-${i}`}>
              <span>
                → {roomName(list.find((x) => x.key === l.to)?.room ?? '',
                  list.findIndex((x) => x.key === l.to))}
                {' '}
                <span className="key">
                  поворот {Math.round(l.yaw)}°, наклон {Math.round(l.pitch)}°
                </span>
              </span>
              <button
                type="button"
                className="btn ghostlink"
                onClick={() => save(
                  here.key,
                  (here.links ?? []).filter((_, j) => j !== i),
                )}
              >
                Убрать
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {saved ? <p className="key">{saved}</p> : null}
    </div>
  );
}
