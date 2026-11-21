import Link from 'next/link';
import { catalogHref, type CatalogFilters } from '@/lib/catalog-params';
import type { Lang } from '@/lib/i18n';

/**
 * Схема районов Бишкека.
 *
 * Это СХЕМА, а не карта, и названа она честно. Карта с метками требует
 * координат у каждого объекта, а их в базе нет: агент вводит адрес
 * словами. Рисовать метки «примерно» на настоящей карте нельзя — человек
 * поедет смотреть не туда.
 *
 * Схема же делает ровно то, ради чего карту и открывают: показывает, где
 * в городе что есть, и даёт нажать на район. Расположение блоков
 * соответствует настоящему: север сверху, горы на юге, Чүй поперёк
 * центра. Местный узнаёт город с первого взгляда.
 *
 * Район без объектов не кликается и приглушён: нажатие, после которого
 * ничего нет, — обман.
 */
type Cell = { name: string; col: string; row: string };

const PLAN: Cell[] = [
  { name: 'Ак-Орго',          col: '1 / 2', row: '1 / 2' },
  { name: 'Шлагбаум',         col: '2 / 3', row: '1 / 2' },
  { name: 'Рабочий городок',  col: '3 / 4', row: '1 / 2' },
  { name: 'Аламедин-1',       col: '4 / 5', row: '1 / 2' },
  { name: 'Тунгуч',           col: '5 / 6', row: '1 / 2' },

  { name: 'Кызыл-Аскер',      col: '1 / 2', row: '2 / 3' },
  { name: 'Центр',            col: '2 / 4', row: '2 / 3' },
  { name: 'Политех',          col: '4 / 5', row: '2 / 3' },
  { name: 'Восток-5',         col: '5 / 6', row: '2 / 3' },

  { name: 'Маевка',           col: '1 / 2', row: '3 / 4' },
  { name: 'Орто-Сай',         col: '2 / 3', row: '3 / 4' },
  { name: 'Мадина',           col: '3 / 4', row: '3 / 4' },
  { name: 'Юг-2',             col: '4 / 5', row: '3 / 4' },
  { name: 'Кок-Жар',          col: '5 / 6', row: '3 / 4' },

  { name: 'Чон-Арык',         col: '1 / 2', row: '4 / 5' },
  { name: 'Джал',             col: '2 / 4', row: '4 / 5' },
  { name: 'Асанбай',          col: '4 / 6', row: '4 / 5' },
];

export function CityMap({
  lang, f, counts, title, hint, empty,
}: {
  lang: Lang;
  f: CatalogFilters;
  counts: Map<string, number>;
  title: string;
  hint: string;
  empty: string;
}) {
  return (
    <section className="citymap">
      <div className="map-head">
        <h2>{title}</h2>
        <span className="key">{hint}</span>
      </div>

      <div className="plan">
        <span className="compass" aria-hidden="true">СЕВЕР</span>

        {/* Чүй поперёк центра — главная ось города. По ней местный
            определяет север и юг быстрее, чем по подписям. */}
        <span className="avenue" aria-hidden="true"><i>Чүй</i></span>

        {PLAN.map((c) => {
          const n = counts.get(c.name) ?? 0;
          const style = { gridColumn: c.col, gridRow: c.row } as React.CSSProperties;
          if (n === 0) {
            return (
              <span className="zone-cell off" style={style} key={c.name}>
                <b>{c.name}</b>
                <small>{empty}</small>
              </span>
            );
          }
          return (
            <Link
              key={c.name}
              className="zone-cell"
              style={style}
              href={catalogHref(lang, { ...f, zone: c.name }, 1)}
              aria-current={f.zone === c.name ? 'true' : undefined}
            >
              <b>{c.name}</b>
              <small className="num">{n}</small>
            </Link>
          );
        })}

        {/* Горы на юге: без них схема — просто сетка прямоугольников. */}
        <span className="ridge" aria-hidden="true">
          <svg viewBox="0 0 600 40" preserveAspectRatio="none">
            <path d="M0 40 L60 16 L110 32 L170 6 L240 30 L300 12 L370 34 L430 14 L500 30 L560 10 L600 26 L600 40 Z" />
          </svg>
        </span>
      </div>
    </section>
  );
}
