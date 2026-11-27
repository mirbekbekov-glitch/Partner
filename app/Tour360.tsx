'use client';

import { useEffect, useRef, useState } from 'react';
import 'pannellum/build/pannellum.css';

/**
 * Виртуальный тур: панорама комнаты, которую крутят мышью или пальцем.
 *
 * Это НЕ трёхмерная модель квартиры. Трёхмерную модель из обычных
 * снимков строят фотограмметрией — это GPU и часы расчёта, и в комнатах
 * с белыми стенами и зеркалами она разваливается. Панорама же — то, что
 * камера действительно видела, и ничего не выдумывает.
 *
 * Углы обзора считаются из размеров снимка. Полная сфера — это 2:1;
 * панорама с телефона выходит полосой 4:1 и шире, и охватывает она те же
 * 360 градусов по кругу, но меньше по вертикали. Если растянуть такую
 * полосу на всю сферу, квартира окажется сплющенной, а потолок — на
 * уровне глаз. Размеры приходят с записью: их посчитал браузер агента.
 *
 * Просмотрщик грузится ТОЛЬКО когда до него дошли, и только в браузере:
 * это двести килобайт кода и WebGL, и платить ими за каждое объявление,
 * у которого тура нет, незачем.
 */

export type TourRoom = { url: string; room: string; w: number; h: number };

type Pannellum = {
  viewer: (el: HTMLElement, config: Record<string, unknown>) => { destroy: () => void };
};

export function Tour360({ rooms, title }: { rooms: TourRoom[]; title: string }) {
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const viewer = useRef<{ destroy: () => void } | null>(null);

  const room = rooms[at];

  useEffect(() => {
    if (!room) return;
    let alive = true;

    (async () => {
      try {
        await import('pannellum/build/pannellum.js');
        const lib = (window as unknown as { pannellum?: Pannellum }).pannellum;
        if (!alive || !lib || !box.current) return;

        viewer.current?.destroy();
        viewer.current = lib.viewer(box.current, {
          type: 'equirectangular',
          panorama: room.url,
          autoLoad: true,
          showZoomCtrl: true,
          showFullscreenCtrl: true,
          // Полный оборот по кругу: инструкция для агента требует снимать
          // панораму, не сходя с места, целиком.
          haov: 360,
          // Сколько градусов по вертикали — считается из пропорций.
          // Размеров нет (старый браузер при загрузке) — считаем сферой.
          vaov: room.w > 0 && room.h > 0 ? Math.min(180, (360 * room.h) / room.w) : 180,
          vOffset: 0,
          hfov: 100,
        });
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
  }, [room]);

  if (rooms.length === 0) return null;

  return (
    <section className="tour">
      <div className="tour-head">
        <h2>{title}</h2>
        {rooms.length > 1 ? (
          <div className="tour-rooms">
            {rooms.map((r, i) => (
              <button
                key={r.url}
                type="button"
                className="tour-room"
                aria-current={i === at ? 'true' : undefined}
                onClick={() => setAt(i)}
              >
                {r.room || `Комната ${i + 1}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="tour-flat" src={room.url} alt={room.room || title} />
      ) : (
        <div className="tour-box" ref={box} />
      )}
    </section>
  );
}
