import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import {
  CATALOG_PAGE_SIZE, parseCatalogFilters, catalogHref, hasAnyFilter,
  firstPhoto, searchTokens, tokenFilter, KIND_RU, type CatalogFilters,
} from '@/lib/catalog-params';
import { money, day } from '@/lib/list-params';
import { CatalogHeader } from './CatalogHeader';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { Photo } from './Photo';

export const metadata = {
  title: 'Объекты в Бишкеке — аренда и продажа',
  description: 'Квартиры, дома и коммерческая недвижимость в Бишкеке.',
};

// Каталог читается анонимно и меняется при каждой правке цены, поэтому
// отдаём свежие данные, а не снимок времени сборки.
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

function Filters({ f }: { f: CatalogFilters }) {
  return (
    <form className="filters" method="get">
      <input name="q" type="search" placeholder="адрес или район" defaultValue={f.q ?? ''} />
      <select name="deal" defaultValue={f.deal ?? ''}>
        <option value="">аренда и продажа</option>
        <option value="sale">продажа</option>
        <option value="rent">аренда</option>
      </select>
      <select name="kind" defaultValue={f.kind ?? ''}>
        <option value="">любой тип</option>
        {Object.entries(KIND_RU).map(([k, ru]) => (
          <option key={k} value={k}>{ru}</option>
        ))}
      </select>
      <input name="rooms" type="number" min={1} max={9} placeholder="комнат"
             defaultValue={f.rooms ?? ''} />
      <input name="from" type="number" min={0} placeholder="цена от"
             defaultValue={f.priceMin ?? ''} />
      <input name="to" type="number" min={0} placeholder="цена до"
             defaultValue={f.priceMax ?? ''} />
      <button type="submit">Показать</button>
      {hasAnyFilter(f) ? <Link href="/" className="key">сбросить</Link> : null}
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

  // Только витрина. В ней нет ни комиссии, ни агента, ни собственника —
  // поэтому публичной странице неоткуда взять то, чего ей знать не нужно.
  let query = supabase
    .from('public_catalog_v')
    .select('*', { count: 'exact' })
    .order('published_at', { ascending: false })
    .range((f.page - 1) * CATALOG_PAGE_SIZE, f.page * CATALOG_PAGE_SIZE - 1);

  if (f.deal) query = query.eq('deal_type', f.deal);
  if (f.kind) query = query.eq('kind', f.kind);
  if (f.zone) query = query.eq('zone', f.zone);
  if (f.rooms) query = query.eq('rooms', f.rooms);
  if (f.priceMin != null) query = query.gte('price', f.priceMin);
  if (f.priceMax != null) query = query.lte('price', f.priceMax);
  // Ищем и по адресу, и по району: человек пишет «Асанбай», не разбираясь,
  // это улица или зона. Кавычки и варианты написания — в searchFilter().
  // Каждое слово — отдельное условие: несколько .or() складываются по И,
  // поэтому «Чуй кв 5» найдёт «Чүй 120, кв. 5», а «Чуй Асанбай» — ничего.
  if (f.q) for (const token of searchTokens(f.q)) query = query.or(tokenFilter(token));

  const { data, count, error } = await query;
  const rows = (data ?? []) as Row[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));

  return (
    <>
      <CatalogHeader />
      <h1>{AGENCY_NAME}</h1>
      <p className="sub">
        {error ? 'Каталог временно недоступен.' : `Сейчас в продаже и аренде: ${total}.`}
      </p>

      <Filters f={f} />

      {error ? (
        <p className="error">{error.message}</p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {hasAnyFilter(f)
            ? 'Под эти условия ничего не подошло. Попробуйте расширить поиск.'
            : 'Пока нет опубликованных объектов.'}
        </p>
      ) : (
        <div className="pub-grid">
          {rows.map((o) => {
            const photo = firstPhoto(o.photos);
            return (
              <Link className="pub-card" key={o.id} href={`/objects/${o.id}`}>
                <div className="pub-photo">
                  {/* Обычный img внутри Photo, а не next/image: ссылки на
                      фото вводят агенты, список доменов заранее неизвестен. */}
                  {photo ? <Photo src={photo} /> : <span className="key">без фото</span>}
                </div>
                <div className="pub-body">
                  <strong className="pub-price">{money(o.price, o.currency)}</strong>
                  <span className="key">
                    {o.deal_type === 'sale' ? 'продажа' : 'аренда'} · {KIND_RU[o.kind] ?? o.kind}
                  </span>
                  <span className="pub-addr">{o.address}</span>
                  <span className="key">
                    {[
                      o.zone,
                      o.rooms ? `${o.rooms} комн.` : null,
                      o.area ? `${o.area} м²` : null,
                      o.floor ? `этаж ${o.floor}${o.floors_total ? ` из ${o.floors_total}` : ''}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  <span className="key">актуально на {day(o.actual_at)}</span>
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
    </>
  );
}
