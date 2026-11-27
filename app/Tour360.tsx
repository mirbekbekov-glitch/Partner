'use client';

import { useEffect, useRef, useState } from 'react';
import 'pannellum/build/pannellum.css';

/**
 * Виртуальный тур: панорамы комнат с переходами между ними.
 *
 * Это НЕ трёхмерная модель квартиры. Трёхмерную модель из обычных
 * снимков строят фотограмметрией — это GPU и часы расчёта, и в комнатах
 * с белыми стенами и зеркалами она разваливается. Панорама же — то, что
 * камера действительно видела, и ничего не выдумывает.
 *
 * Переходы — точки на самой панораме: нажал на дверь, оказался в
 * спальне. Так ходят по квартире, и так же покупатель ходит по туру.
 * Кнопки комнат сверху остаются: это запасной путь для тех, кому
 * переходы агент не расставил, и быстрый — для тех, кто знает, куда
 * хочет.
 *
 * Углы обзора считаются из размеров снимка. Полная сфера — это 2:1;
 * панорама с телефона выходит полосой 4:1 и шире, и охватывает она те же
 * 360 градусов по кругу, но меньше по вертикали. Если растянуть такую
 * полосу на всю сферу, квартира окажется сплющенной, а потолок — на
 * уровне глаз.
 *
 * Просмотрщик грузится ТОЛЬКО когда до него дошли, и только в браузере:
 * это двести килобайт кода и WebGL, и платить ими за каждое объявление,
 * у которого тура нет, незачем.
 */

export type TourRoom = {
  key: string;
  url: string;
  room: string;
  w: number;
  h: number;
  links?: { to: string; yaw: number; pitch: number }[];
};

type Viewer = {
  destroy: () => void;
  loadScene: (id: string) => void;
  getScene: () => string;
  on: (event: string, handler: () => void) => void;
};

type Pannellum = {
  viewer: (el: HTMLElement, config: Record<string, unknown>) => Viewer;
};

/** Сколько градусов по вертикали охватывает снимок. */
export function vaovOf(w: number, h: number): number {
  return w > 0 && h > 0 ? Math.min(180, (360 * h) / w) : 180;
}

/** Имя комнаты для подписи: своё или порядковое. */
export function roomName(room: string, index: number): string {
  return room.trim() || `Комната ${index + 1}`;
}

export function Tour360({ rooms, title }: { rooms: TourRoom[]; title: string }) {
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  // Один просмотрщик на все комнаты: Pannellum умеет переключать сцены
  // сам, и пересоздавать его на каждый переход значило бы заново грузить
  // снимок и терять плавность, ради которой тур и делают.
  useEffect(() => {
    if (rooms.length === 0) return;
    let alive = true;

    (async () => {
      try {
        await import('pannellum/build/pannellum.js');
        const lib = (window as unknown as { pannellum?: Pannellum }).pannellum;
        if (!alive || !lib || !box.current) {
          if (alive && !lib) setFailed(true);
          return;
        }

        const scenes: Record<string, unknown> = {};
        rooms.forEach((r, i) => {
          scenes[r.key] = {
            type: 'equirectangular',
            panorama: r.url,
            title: roomName(r.room, i),
            haov: 360,
            vaov: vaovOf(r.w, r.h),
            vOffset: 0,
            hfov: 100,
            hotSpots: (r.links ?? []).map((l) => ({
              pitch: l.pitch,
              yaw: l.yaw,
              type: 'scene',
              sceneId: l.to,
              text: roomName(
                rooms.find((x) => x.key === l.to)?.room ?? '',
                rooms.findIndex((x) => x.key === l.to),
              ),
            })),
          };
        });

        viewer.current?.destroy();
        const v = lib.viewer(box.current, {
          default: { firstScene: rooms[0].key, autoLoad: true, sceneFadeDuration: 900 },
          scenes,
        });

        // Переход внутри панорамы меняет комнату, и кнопка сверху должна
        // это показать: иначе человек стоит в спальне, а подсвечена кухня.
        v.on('scenechange', () => {
          if (!alive) return;
          const i = rooms.findIndex((r) => r.key === v.getScene());
          if (i >= 0) setAt(i);
        });

        viewer.current = v;
      } catch {
        // Просмотрщик не загрузился или WebGL выключен: показываем
        // панораму обычной картинкой. Крутить её нельзя, но увидеть
        // комнату можно, и это лучше пустого места.
        if (alive) setFailed(true);
      }
    })();

    return () => {
      alive = false;
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [rooms]);

  if (rooms.length === 0) return null;
  const room = rooms[at];

  return (
    <section className="tour">
      <div className="tour-head">
        <h2>{title}</h2>
        {rooms.length > 1 ? (
          <div className="tour-rooms">
            {rooms.map((r, i) => (
              <button
                key={r.key}
                type="button"
                className="tour-room"
                aria-current={i === at ? 'true' : undefined}
                onClick={() => {
                  setAt(i);
                  viewer.current?.loadScene(r.key);
                }}
              >
                {roomName(r.room, i)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="tour-flat" src={room.url} alt={roomName(room.room, at)} />
      ) : (
        <div className="tour-box" ref={box} />
      )}
    </section>
  );
}
