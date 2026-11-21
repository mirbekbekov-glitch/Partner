import Link from 'next/link';
import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import {
  CATALOG_PAGE_SIZE, parseCatalogFilters, catalogHref, sortHref, hasAnyFilter,
  firstPhoto, searchTokens, tokenFilter, daysSince,
  SORTS, publicMoney, type CatalogFilters,
} from '@/lib/catalog-params';
import { t, kindName, freshWordIn, LANGS, isLang, type Lang } from '@/lib/i18n';
import { CatalogHeader } from '../CatalogHeader';
import { CatalogFooter } from '../CatalogFooter';
import { Facade } from '../Facade';
import { Photo } from '../Photo';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string }> },
): Promise<Metadata> {
  const { lang } = await params;
  const d = t(isLang(lang) ? lang : 'ru');
  return {
    title: d.siteTitle,
    description: d.siteDescription,
    // Четыре версии одной страницы: без этого поисковик считает их
    // копиями и оставляет в выдаче одну.
    alternates: {
      canonical: `/${lang}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}`])),
    },
  };
}

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

function Search({ lang, f }: { lang: Lang; f: CatalogFilters }) {
  const d = t(lang);
  const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return (
    <form className="search" method="get">
      {/* Сортировка живёт в ссылках, но при новом поиске её надо сохранить. */}
      {f.sort !== 'fresh' ? <input type="hidden" name="sort" value={f.sort} /> : null}
      <div className="f">
        <label htmlFor="q">{d.address}</label>
        <input id="q" name="q" type="search" placeholder={d.addressHint}
               defaultValue={f.q ?? ''} autoComplete="off" />
      </div>
      <div className="f">
        <label htmlFor="deal">{d.deal}</label>
        <select id="deal" name="deal" defaultValue={f.deal ?? ''}>
          <option value="">{d.anyDeal}</option>
          <option value="sale">{d.sale}</option>
          <option value="rent">{d.rent}</option>
        </select>
      </div>
      <div className="f">
        <label htmlFor="kind">{d.kind}</label>
        <select id="kind" name="kind" defaultValue={f.kind ?? ''}>
          <option value="">{d.anyKind}</option>
          {Object.entries(d.kinds).map(([k, name]) => (
            <option key={k} value={k}>{up(name)}</option>
          ))}
        </select>
      </div>
      <div className="f">
        <label htmlFor="rooms">{d.rooms}</label>
        <select id="rooms" name="rooms" defaultValue={f.rooms ?? ''}>
          <option value="">{d.anyRooms}</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="f">
        <label htmlFor="to">{d.priceTo}</label>
        <input id="to" name="to" type="number" min={0} step={1000} placeholder={d.priceHint}
               inputMode="numeric" defaultValue={f.priceMax ?? ''} />
      </div>
      <button type="submit">{d.search}</button>
    </form>
  );
}

export default async function Catalog({
  params,
  searchParams,
}: {
  params: Promise<{ lang: Lang }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang } = await params;
  const d = t(lang);
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
  const sortLabel: Record<string, string> = {
    fresh: d.sortFresh, cheap: d.sortCheap, big: d.sortBig,
  };

  return (
    <>
      <CatalogHeader lang={lang} />

      <div className="hero">
        <div className="hero-in">
          <h1>{d.heroTitle}</h1>
          <p className="lede">{d.heroLede}</p>
          <Search lang={lang} f={f} />
        </div>
      </div>

      <div className="pub-wrap">
      <div className="pub-bar">
        <h1>
          {f.deal === 'rent' ? d.forRent : f.deal === 'sale' ? d.forSale : d.forSaleAndRent}
        </h1>
        <span className="count">
          {error ? d.catalogDown : d.objectsCount(total)}
        </span>
        <div className="sorts">
          {SORTS.map((s) => (
            <Link key={s.key} className="sort" href={sortHref(lang, f, s.key)}
                  aria-current={f.sort === s.key ? 'true' : undefined}>
              {sortLabel[s.key]}
            </Link>
          ))}
        </div>
      </div>

      {error ? (
        <p className="error">{error.message}</p>
      ) : rows.length === 0 ? (
        <p className="empty">{hasAnyFilter(f) ? d.nothingFound : d.nothingYet}</p>
      ) : (
        <div className="pub-grid">
          {rows.map((o) => {
            const photo = firstPhoto(o.photos);
            const days = daysSince(o.actual_at);
            const fresh = freshWordIn(lang, days);
            const facade = <Facade o={o} />;
            const kind = kindName(lang, o.kind);
            return (
              <Link className="pub-card" key={o.id} href={`/${lang}/objects/${o.id}`}>
                <div className="shot">
                  {photo ? <Photo src={photo} fallback={facade} /> : facade}
                  {/* Метка свежести — единственная, за которой есть данные:
                      её держит инвариант 5, а не маркетинг. */}
                  {days <= 3 ? (
                    <div className="tags">
                      <span className="tag-sm">{d.confirmed} {fresh}</span>
                    </div>
                  ) : null}
                </div>
                <div className="pub-body">
                  <span className="pub-price">
                    {publicMoney(lang, o.price, o.currency)}
                    {o.deal_type === 'rent' ? <span className="per">{d.perMonth}</span> : null}
                  </span>
                  <span className="pub-addr">{o.address}</span>
                  <span className="pub-meta">
                    {[kind.charAt(0).toUpperCase() + kind.slice(1), o.zone,
                      o.rooms ? `${o.rooms} ${d.roomsShort}` : null,
                      o.area ? `${o.area} ${d.sqm}` : null,
                      o.floor
                        ? `${d.floorShort} ${o.floor}${o.floors_total ? ` ${d.floorOf} ${o.floors_total}` : ''}`
                        : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  <span className="pub-foot">
                    <span className="dot" />{d.confirmedBy} {fresh}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager">
          <span className="key">{d.pageOf(f.page, pages)}</span>
          {f.page > 1 ? <Link href={catalogHref(lang, f, f.page - 1)}>{d.back}</Link> : null}
          {f.page < pages ? <Link href={catalogHref(lang, f, f.page + 1)}>{d.forward}</Link> : null}
        </div>
      ) : null}
      </div>

      <CatalogFooter lang={lang} />
    </>
  );
}
