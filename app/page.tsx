import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import {
  CATALOG_PAGE_SIZE, parseCatalogFilters, catalogHref, sortHref, hasAnyFilter,
  firstPhoto, searchTokens, tokenFilter, daysSince, freshWord, objectsWord,
  SORTS, KIND_RU, publicMoney, kindTitle, type CatalogFilters,
} from '@/lib/catalog-params';
import { CatalogHeader } from './CatalogHeader';
import { CatalogFooter } from './CatalogFooter';
import { Facade } from './Facade';
import { Photo } from './Photo';

export const metadata = {
  title: 'Недвижимость в Бишкеке: аренда и продажа — Liberterra',
  description: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
};

export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price: number;
  currency: string;
  photos: unknown;
  actual_at: string;
};

function Search({ f }: { f: CatalogFilters }) {
  return (
    <form className="search" method="get">
      {/* Сортировка живёт в ссылках, но при новом поиске её надо сохранить. */}
      {f.sort !== 'fresh' ? <input type="hidden" name="sort" value={f.sort} /> : null}
      <div className="f">
        <label htmlFor="q">Адрес или район</label>
        <input id="q" name="q" type="search" placeholder="Чүй, Асанбай, Джал…"
               defaultValue={f.q ?? ''} autoComplete="off" />
      </div>
      <div className="f">
        <label htmlFor="deal">Сделка</label>
        <select id="deal" name="deal" defaultValue={f.deal ?? ''}>
          <option value="">Любая</option>
          <option value="sale">Продажа</option>
          <option value="rent">Аренда</option>
        </select>
      </div>
      <div className="f">
        <label htmlFor="kind">Тип</label>
        <select id="kind" name="kind" defaultValue={f.kind ?? ''}>
          <option value="">Любой</option>
          {Object.entries(KIND_RU).map(([k, ru]) => (
            <option key={k} value={k}>{ru[0].toUpperCase() + ru.slice(1)}</option>
          ))}
        </select>
      </div>
      <div className="f">
        <label htmlFor="rooms">Комнат</label>
        <select id="rooms" name="rooms" defaultValue={f.rooms ?? ''}>
          <option value="">Любое</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="f">
        <label htmlFor="to">Цена до</label>
        <input id="to" name="to" type="number" min={0} step={1000} placeholder="120 000"
               inputMode="numeric" defaultValue={f.priceMax ?? ''} />
      </div>
      <button type="submit">Показать</button>
    </form>
  );
}

export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const f = parseCatalogFilters(await searchParams);
  const supabase = await createClient();
  const order = SORTS.find((s) => s.key === f.sort) ?? SORTS[0];

  // Только витрина. В ней нет ни комиссии, ни агента, ни собственника.
  let query = supabase
    .from('public_catalog_v')
    .select('*', { count: 'exact' })
    .order(order.column, { ascending: order.asc, nullsFirst: false })
    .range((f.page - 1) * CATALOG_PAGE_SIZE, f.page * CATALOG_PAGE_SIZE - 1);

  if (f.deal) query = query.eq('deal_type', f.deal);
  if (f.kind) query = query.eq('kind', f.kind);
  if (f.zone) query = query.eq('zone', f.zone);
  if (f.rooms) query = query.eq('rooms', f.rooms);
  if (f.priceMin != null) query = query.gte('price', f.priceMin);
  if (f.priceMax != null) query = query.lte('price', f.priceMax);
  if (f.q) for (const token of searchTokens(f.q)) query = query.or(tokenFilter(token));

  const { data, count, error } = await query;
  const rows = (data ?? []) as Row[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));

  return (
    <>
      <CatalogHeader />

      <div className="hero">
        <div className="hero-in">
          <h1>Квартиры, дома и участки в Бишкеке</h1>
          <p className="lede">
            Каждое объявление ведёт агент Liberterra: цену и доступность он подтверждает
            лично, а дата на карточке показывает, когда это было в последний раз.
          </p>
          <Search f={f} />
        </div>
      </div>

      <div className="pub-wrap">
      <div className="pub-bar">
        <h1>
          {f.deal === 'rent' ? 'В аренде' : f.deal === 'sale' ? 'В продаже' : 'В продаже и аренде'}
        </h1>
        <span className="count">
          {error ? 'каталог временно недоступен' : `${total} ${objectsWord(total)}`}
        </span>
        <div className="sorts">
          {SORTS.map((s) => (
            <Link key={s.key} className="sort" href={sortHref(f, s.key)}
                  aria-current={f.sort === s.key ? 'true' : undefined}>
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {error ? (
        <p className="error">{error.message}</p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {hasAnyFilter(f)
            ? 'Под эти условия ничего не подошло. Попробуйте расширить поиск — например, убрать ограничение по цене.'
            : 'Пока нет опубликованных объектов.'}
        </p>
      ) : (
        <div className="pub-grid">
          {rows.map((o) => {
            const photo = firstPhoto(o.photos);
            const days = daysSince(o.actual_at);
            const facade = <Facade o={o} />;
            return (
              <Link className="pub-card" key={o.id} href={`/objects/${o.id}`}>
                <div className="shot">
                  {photo ? <Photo src={photo} fallback={facade} /> : facade}
                  {/* Метка свежести — единственная, за которой есть данные:
                      её держит инвариант 5, а не маркетинг. */}
                  {days <= 3 ? (
                    <div className="tags"><span className="tag-sm">Подтверждён {freshWord(days)}</span></div>
                  ) : null}
                </div>
                <div className="pub-body">
                  <span className="pub-price">
                    {publicMoney(o.price, o.currency)}
                    {o.deal_type === 'rent' ? <span className="per"> / мес.</span> : null}
                  </span>
                  <span className="pub-addr">{o.address}</span>
                  <span className="pub-meta">
                    {[kindTitle(o.kind), o.zone, o.rooms ? `${o.rooms} комн.` : null,
                      o.area ? `${o.area} м²` : null,
                      o.floor ? `этаж ${o.floor}${o.floors_total ? ` из ${o.floors_total}` : ''}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  <span className="pub-foot">
                    <span className="dot" />Агент подтвердил {freshWord(days)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager">
          <span className="key">страница {f.page} из {pages}</span>
          {f.page > 1 ? <Link href={catalogHref(f, f.page - 1)}>← назад</Link> : null}
          {f.page < pages ? <Link href={catalogHref(f, f.page + 1)}>вперёд →</Link> : null}
        </div>
      ) : null}
      </div>

      <CatalogFooter />
    </>
  );
}
