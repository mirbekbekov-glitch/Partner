'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import 'leaflet/dist/leaflet.css';
import type { Lang } from '@/lib/i18n';
import type { MapPoint } from '@/lib/db/catalog';
import { cluster, middle, shortPrice } from '@/lib/map-cluster';

/**
 * Карта витрины: булавки с ценой, сгущения числом, поиск при движении.
 *
 * Зачем она вообще. Человек, который ищет жильё, думает местом, а не
 * строкой адреса: «рядом с работой», «у этой школы», «вот в этом
 * квадрате». Список по районам отвечает на этот вопрос приблизительно —
 * район Бишкека бывает в три километра поперёк.
 *
 * Сгущения считаем сами, без плагина. Готовый markercluster — это ещё
 * сорок килобайт и своя вёрстка булавок, а нужна от него одна вещь:
 * сетка по экрану. Сетка в сорок строк кода, зато булавка остаётся
 * нашей и подписывается ценой, а не точкой.
 *
 * «Искать при перемещении» — выключаемая, и по умолчанию включена: так
 * устроено у всех, и человек этого ждёт. Выключается она для того
 * случая, когда карту двигают, чтобы посмотреть, а не чтобы искать.
 *
 * Карта грузится только в браузере и только на этой странице: двести
 * килобайт Leaflet не должны платиться на каждой странице каталога.
 */

const BISHKEK: [number, number] = [42.8746, 74.6122];

/** Сторона клетки сгущения в пикселях экрана. */
const CELL = 64;

type Dict = {
  moveSearch: string;
  found: (n: number) => string;
  partial: (shown: number, total: number) => string;
  empty: string;
  loading: string;
  roomsShort: string;
  sqm: string;
  mapFix: string;
  mln: string;
  thd: string;
  som: string;
};

/**
 * Булавка с подписью, которая не вываливается из иконки.
 *
 * Leaflet задаёт иконке размер в 12×12 пикселей, если не сказано иное, и
 * подпись «10.9 млн с» из неё торчит: на экране остаётся голый текст и
 * белое пятнышко под первой буквой. Это было видно только в браузере —
 * ни типы, ни прогон такого не ловят.
 *
 * Размера не задаём вовсе (iconSize: undefined — Leaflet перестаёт
 * выставлять width и height), а саму плашку рисует ВНУТРЕННИЙ span.
 * Снаружи Leaflet двигает элемент своим transform, и поставить туда же
 * своё смещение нельзя — оно затёрло бы положение на карте. Внутренний
 * span центрируется сам, и ширина подписи может быть любой.
 *
 * Подпись вставляется в html, поэтому экранируется: сюда приходит цена,
 * то есть число, но правило дешевле соблюдать, чем однажды вспомнить.
 */
function pin(
  mod: typeof import('leaflet'), className: string, text: string,
): import('leaflet').DivIcon {
  const safe = text.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
  return mod.divIcon({
    className,
    html: `<span>${safe}</span>`,
    iconSize: undefined,
  });
}

export function CatalogMap({
  lang, points, total, shown, query, tiles, d,
}: {
  lang: Lang;
  points: MapPoint[];
  total: number;
  shown: number;
  /** Строка фильтров без границ карты: их дописывает сама карта. */
  query: string;
  /** Откуда плитки и чьей подписью. Приходит настройкой, а не вшит. */
  tiles: { url: string; attribution: string };
  d: Dict;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import('leaflet').Map | null>(null);
  const layer = useRef<import('leaflet').LayerGroup | null>(null);
  const L = useRef<typeof import('leaflet') | null>(null);

  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState({ points, total, shown });
  const [active, setActive] = useState<string | null>(null);

  // Свежие значения для обработчиков карты: обработчик вешается один раз
  // и иначе навсегда запомнил бы первое состояние.
  const liveRef = useRef(live);
  liveRef.current = live;
  const queryRef = useRef(query);
  queryRef.current = query;

  /** Перечитать точки под текущую рамку. */
  const reload = useCallback(async () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    const params = new URLSearchParams(queryRef.current);
    params.set('south', String(b.getSouth()));
    params.set('west', String(b.getWest()));
    params.set('north', String(b.getNorth()));
    params.set('east', String(b.getEast()));

    setBusy(true);
    try {
      const response = await fetch(`/api/catalog/points?${params}`, {
        headers: { accept: 'application/json' },
      });
      const data = await response.json() as {
        points: MapPoint[]; total: number; shown: number;
      };
      setState(data);
    } catch {
      // Сеть моргнула — на карте остаются прежние булавки. Пустая карта
      // вместо них соврала бы, что здесь ничего нет.
    } finally {
      setBusy(false);
    }
  }, []);

  // Создание карты — один раз.
  useEffect(() => {
    let alive = true;

    (async () => {
      const mod = await import('leaflet');
      if (!alive || !box.current || map.current) return;
      L.current = mod;

      const m = mod.map(box.current, { center: BISHKEK, zoom: 12 });
      // Leaflet по умолчанию подписывает карту своим значком с флагом.
      // На странице агентства недвижимости чужой флаг — это заявление,
      // которого мы не делали. Ссылка на OpenStreetMap остаётся: её
      // требует лицензия карты, а значок — нет.
      m.attributionControl.setPrefix(false);
      mod.tileLayer(tiles.url, {
        maxZoom: 19,
        attribution: tiles.attribution,
      }).addTo(m);

      layer.current = mod.layerGroup().addTo(m);
      map.current = m;

      // Рамка по тому, что пришло с сервера: иначе карта открывается на
      // Бишкеке, а объекты — в Оше, и человек видит пустое поле.
      if (points.length > 0) {
        m.fitBounds(
          mod.latLngBounds(points.map((p) => [p.latitude, p.longitude])),
          { padding: [40, 40], maxZoom: 15 },
        );
      }

      m.on('moveend', () => { if (liveRef.current) void reload(); });
      // Первая отрисовка сетки.
      setState((s) => ({ ...s }));
    })();

    return () => { alive = false; };
    // Намеренно один раз: пересоздание карты теряло бы масштаб и
    // положение, которые человек выбрал руками.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Фильтры сменились — страница пришла с новыми точками.
  useEffect(() => {
    setState({ points, total, shown });
  }, [points, total, shown]);

  // Перерисовка булавок: на каждое изменение точек, масштаба и выбора.
  useEffect(() => {
    const mod = L.current;
    const m = map.current;
    const group = layer.current;
    if (!mod || !m || !group) return;

    const draw = () => {
      group.clearLayers();

      // Сетка по экрану, а не по градусам: клетка в градусах на севере
      // и на юге — разного размера на вид, и сгущения получались бы
      // кривыми.
      const cells = cluster(
        state.points,
        (p) => m.latLngToContainerPoint([p.latitude, p.longitude]),
        CELL,
      );

      for (const cell of cells) {
        if (cell.items.length === 1) {
          const p = cell.items[0]!;
          const on = active === p.id;
          mod.marker([p.latitude, p.longitude], {
            icon: pin(mod, `map-price${on ? ' on' : ''}`,
              shortPrice(p.price, p.currency, d)),
          })
            .addTo(group)
            .on('click', () => setActive(p.id));
        } else {
          mod.marker(middle(cell.items), {
            icon: pin(mod, 'map-cluster', String(cell.items.length)),
          })
            .addTo(group)
            .on('click', () => {
              m.flyToBounds(
                mod.latLngBounds(cell.items.map((p) => [p.latitude, p.longitude])),
                { padding: [60, 60] },
              );
            });
        }
      }
    };

    draw();
    m.on('zoomend', draw);
    m.on('moveend', draw);
    return () => { m.off('zoomend', draw); m.off('moveend', draw); };
  }, [state.points, active, d]);

  return (
    <div className="map-page">
      <div className="map-side">
        <div className="map-head">
          <b className="num">{d.found(state.total)}</b>
          {busy ? <span className="key">{d.loading}</span> : null}
          <label className="map-live">
            <input type="checkbox" checked={live}
                   onChange={(e) => setLive(e.target.checked)} />
            <span>{d.moveSearch}</span>
          </label>
          {/* Показана часть — об этом говорим прямо: молчаливые пятьсот
              случайных булавок выглядели бы как весь рынок. */}
          {state.shown < state.total ? (
            <p className="key">{d.partial(state.shown, state.total)}</p>
          ) : null}
          {/* Ошибку в самой карте — не в объявлении — правят в
              OpenStreetMap, и ссылку на это просит их же политика.
              Нам она тоже на руку: пропавшая улица чинится там
              навсегда, а не обходится у нас подпоркой. */}
          <a className="key map-fix" href="https://www.openstreetmap.org/fixthemap"
             target="_blank" rel="noreferrer">{d.mapFix}</a>
        </div>

        <div className="map-list">
          {state.points.length === 0 ? (
            <p className="empty">{d.empty}</p>
          ) : state.points.map((p) => (
            <Link key={p.id} href={`/${lang}/objects/${p.id}`}
                  className={active === p.id ? 'map-card on' : 'map-card'}
                  onMouseEnter={() => setActive(p.id)}>
              <span className="price num">{shortPrice(p.price, p.currency, d)}</span>
              <span className="addr">{p.address}</span>
              <span className="key">
                {[p.rooms ? `${p.rooms} ${d.roomsShort}` : null,
                  p.area ? `${p.area} ${d.sqm}` : null].filter(Boolean).join(' · ')}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="map-canvas" ref={box} />
    </div>
  );
}
