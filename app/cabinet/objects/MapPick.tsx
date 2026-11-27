'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { findOnMap } from './form-actions';
import 'leaflet/dist/leaflet.css';

/**
 * Точка объекта на карте.
 *
 * Широта и долгота — не человеческий язык. Агент знает дом, а не
 * «42.819242». Пока в форме стояли два числовых поля, координат не
 * появлялось вовсе, а без них объявление не берёт ни одна площадка:
 * поле было, а работы от него не было.
 *
 * Поэтому здесь карта: нажать — точка встанет, потянуть — переедет.
 * Кнопка «Найти по адресу» ставит первую догадку по тому, что уже
 * введено в карточке; догадка показана на карте и правится рукой, а не
 * принимается молча.
 *
 * Числа остались и остались доступными для правки: координаты иногда
 * присылают текстом, и вставить их должно быть можно. Карта и поля —
 * одно и то же значение с двух сторон.
 *
 * Карта грузится только в браузере и только когда до неё дошли: это
 * двести килобайт, и платить ими за каждую карточку объекта незачем.
 */

const BISHKEK: [number, number] = [42.8746, 74.6122];

type Leaflet = typeof import('leaflet');

export function MapPick({
  lat, lng,
}: {
  lat: number | null;
  lng: number | null;
}) {
  const [point, setPoint] = useState<[number, number] | null>(
    lat != null && lng != null ? [lat, lng] : null,
  );
  const [found, setFound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import('leaflet').Map | null>(null);
  const mark = useRef<import('leaflet').Marker | null>(null);
  const L = useRef<Leaflet | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      const mod = await import('leaflet');
      if (!alive || !box.current || map.current) return;
      L.current = mod;

      const m = mod.map(box.current, {
        center: point ?? BISHKEK,
        zoom: point ? 17 : 12,
        // Колесо мыши на длинной форме — это прокрутка страницы, а не
        // масштаб: иначе агент, листающий карточку, проваливается в
        // карту и теряет место. Масштаб — кнопками и двумя пальцами.
        scrollWheelZoom: false,
      });

      mod.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(m);

      m.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        setPoint([e.latlng.lat, e.latlng.lng]);
        setFound(null);
      });

      map.current = m;
    })();

    return () => { alive = false; };
    // Карта создаётся один раз: пересоздавать её на каждое изменение
    // точки значило бы терять масштаб и положение, которые агент уже
    // выбрал руками.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Точка и карта — одно значение с двух сторон: метка переставляется
  // всякий раз, когда значение сменилось, кем бы оно ни было задано.
  useEffect(() => {
    const mod = L.current;
    const m = map.current;
    if (!mod || !m) return;

    if (!point) {
      mark.current?.remove();
      mark.current = null;
      return;
    }

    if (!mark.current) {
      mark.current = mod.marker(point, {
        draggable: true,
        // Своя метка, а не картинка из пакета: пути к картинкам при
        // сборке ломаются, и метка пропадает молча.
        icon: mod.divIcon({ className: 'map-pin', iconSize: [18, 18] }),
      }).addTo(m);

      mark.current.on('dragend', () => {
        const p = mark.current?.getLatLng();
        if (p) { setPoint([p.lat, p.lng]); setFound(null); }
      });
    } else {
      mark.current.setLatLng(point);
    }
  }, [point]);

  const byAddress = () => {
    setError(null);
    const form = box.current?.closest('form');
    if (!form) return;

    const data = new FormData(form);
    start(async () => {
      const spot = await findOnMap(data);
      if (!spot.point) { setError(spot.error ?? 'Не нашли такой адрес'); setFound(null); return; }
      setPoint([spot.point.lat, spot.point.lon]);
      setFound(spot.point.label);
      map.current?.setView([spot.point.lat, spot.point.lon], 17);
    });
  };

  const round = (n: number) => String(Math.round(n * 1e6) / 1e6);

  return (
    <div className="field mappick">
      <div className="mappick-head">
        <span className="key">Точка на карте</span>
        <button type="button" className="btn ghostlink" onClick={byAddress} disabled={busy}>
          {busy ? 'Ищем…' : 'Найти по адресу'}
        </button>
        {point ? (
          <button type="button" className="btn ghostlink"
                  onClick={() => { setPoint(null); setFound(null); }}>
            Убрать точку
          </button>
        ) : null}
      </div>

      <div className="mappick-box" ref={box} />

      <p className="key">
        {error
          ? error
          : found
            ? `Нашли: ${found}. Проверьте и при необходимости перетащите точку.`
            : point
              ? 'Нажмите по карте или потяните точку, чтобы поправить.'
              : 'Нажмите по карте, где стоит дом, или найдите по адресу.'}
      </p>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="latitude">Широта</label>
          <input id="latitude" name="latitude" type="text" inputMode="decimal"
                 value={point ? round(point[0]) : ''}
                 placeholder="42.819242"
                 onChange={(e) => {
                   const v = Number(e.target.value);
                   setPoint(Number.isFinite(v) ? [v, point?.[1] ?? BISHKEK[1]] : null);
                 }} />
        </div>
        <div className="field">
          <label className="key" htmlFor="longitude">Долгота</label>
          <input id="longitude" name="longitude" type="text" inputMode="decimal"
                 value={point ? round(point[1]) : ''}
                 placeholder="74.619628"
                 onChange={(e) => {
                   const v = Number(e.target.value);
                   setPoint(Number.isFinite(v) ? [point?.[0] ?? BISHKEK[0], v] : null);
                 }} />
        </div>
      </div>
    </div>
  );
}
