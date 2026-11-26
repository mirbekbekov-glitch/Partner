import Link from 'next/link';
import { catalogHref, type CatalogFilters } from '@/lib/catalog-params';
import type { Lang } from '@/lib/i18n';
import type { CityPlan } from '@/lib/city-plans';

/**
 * Схема районов города.
 *
 * Сама раскладка живёт в lib/city-plans.ts — там же сказано, почему это
 * схема, а не карта, и почему город попадает туда только с чьих-то слов.
 * Здесь остаётся только рисование: компонент не знает ни одного города
 * по имени.
 *
 * Район без объектов не кликается и приглушён: нажатие, после которого
 * ничего нет, — обман.
 */

export function CityMap({
  lang, f, counts, plan, title, hint, empty,
}: {
  lang: Lang;
  f: CatalogFilters;
  counts: Map<string, number>;
  plan: CityPlan;
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

        {/* Главная ось города: по ней местный определяет стороны света
            быстрее, чем по подписям. */}
        <span className="avenue" aria-hidden="true"><i>{plan.avenue}</i></span>

        {plan.cells.map((c) => {
          const n = counts.get(c.name) ?? 0;
          const style = { gridColumn: c.col, gridRow: c.row } as React.CSSProperties;
          // Район без объектов — часть плана города, а не пустая полка.
          // Подпись «пока пусто» в каждой второй ячейке читалась как
          // «площадка полупустая» и била по доверию сильнее, чем
          // отсутствие самого района.
          if (n === 0) {
            return (
              <span className="zone-cell off" style={style} key={c.name} title={empty}>
                <b>{c.name}</b>
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

        {/* Горы на юге: без них схема — просто сетка прямоугольников.
            Рисуются не везде: город в долине без гряды на юге выглядел бы
            не собой. */}
        {plan.ridge ? (
        <span className="ridge" aria-hidden="true">
          <svg viewBox="0 0 600 40" preserveAspectRatio="none">
            <path d="M0 40 L60 16 L110 32 L170 6 L240 30 L300 12 L370 34 L430 14 L500 30 L560 10 L600 26 L600 40 Z" />
          </svg>
        </span>
        ) : null}
      </div>
    </section>
  );
}
