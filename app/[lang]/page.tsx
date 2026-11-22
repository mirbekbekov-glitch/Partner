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
import { HeroArt } from '../HeroArt';
import { FindButton } from '../FindButton';
import { RequestPitch } from '../RequestPitch';
import { CityMap } from '../CityMap';
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

function Search({ lang, f, deal }: { lang: Lang; f: CatalogFilters; deal: 'sale' | 'rent' }) {
  const d = t(lang);
  const up = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
  // Две вкладки, а не три. Поиск жилья бинарен: человек либо покупает,
  // либо снимает, и «всё сразу» было ответом на вопрос, которого никто
  // не задаёт. Отсутствие параметра означает покупку — так же, как на
  // любой площадке, куда человек приходит по привычке.
  const active: 'sale' | 'rent' = f.deal ?? 'sale';
  const tabs: [CatalogFilters['deal'], 'sale' | 'rent', string][] = [
    [null, 'sale', d.tabBuy], ['rent', 'rent', d.tabRent],
  ];
  return (
    <div className="console">
      {/* Вкладки вместо выпадающего списка «Сделка»: купить и снять — это
          два разных похода человека, а не значение поля. Ссылками, а не
          кнопками: выбранная вкладка должна быть в адресе, чтобы ссылкой
          на «аренду в Асанбае» можно было поделиться. */}
      <div className="tabs">
        {tabs.map(([v, key, label]) => (
          <Link key={label} href={catalogHref(lang, { ...f, deal: v }, 1)}
                className="tab" aria-current={active === key ? 'true' : undefined}>
            {label}
          </Link>
        ))}
      </div>

      <form method="get">
        {/* Сортировка и вкладка живут в ссылках, но при новом поиске их
            надо сохранить. */}
        {f.sort !== 'fresh' ? <input type="hidden" name="sort" value={f.sort} /> : null}
        {f.deal ? <input type="hidden" name="deal" value={f.deal} /> : null}
        <div className="row">
          <div className="cell">
            <label htmlFor="q">{d.address}</label>
            <input id="q" name="q" type="search" placeholder={d.addressHint}
                   defaultValue={f.q ?? ''} autoComplete="off" />
          </div>
          <div className="cell">
            <label htmlFor="kind">{d.kind}</label>
            <select id="kind" name="kind" defaultValue={f.kind ?? ''}>
              <option value="">{d.anyKind}</option>
              {Object.entries(d.kinds).map(([k, name]) => (
                <option key={k} value={k}>{up(name)}</option>
              ))}
            </select>
          </div>
          <div className="cell">
            <label htmlFor="rooms">{d.rooms}</label>
            <select id="rooms" name="rooms" defaultValue={f.rooms ?? ''}>
              <option value="">{d.anyRooms}</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="cell">
            <label htmlFor="to">{d.priceTo}</label>
            <input id="to" name="to" type="number" min={0} step={1000} placeholder={d.priceHint}
                   inputMode="numeric" defaultValue={f.priceMax ?? ''} />
          </div>
          <FindButton lang={lang} deal={deal} />
        </div>

        {/* Район и нижняя граница цены нужны меньшинству, но нужны всерьёз.
            Складкой, а не шестым полем: пульт из шести полей пугает. */}
        <details className="more" open={Boolean(f.zone || f.priceMin != null)}>
          <summary>{d.moreFilters}</summary>
          <div className="row sub">
            <div className="cell">
              <label htmlFor="zone">{d.zoneLabel}</label>
              <input id="zone" name="zone" type="text" defaultValue={f.zone ?? ''}
                     placeholder={d.addressHint} autoComplete="off" />
            </div>
            <div className="cell">
              <label htmlFor="from">{d.priceFrom}</label>
              <input id="from" name="from" type="number" min={0} step={1000}
                     inputMode="numeric" defaultValue={f.priceMin ?? ''} />
            </div>
          </div>
        </details>
      </form>
    </div>
  );
}

/** Галочка подтверждения. */
const Check = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Ступенька из знака: шесть квадратов лесенкой. */
const Stair = () => (
  <span className="stair" aria-hidden="true">
    <i /><i /><i /><i /><i /><i />
  </span>
);

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
  // Нет параметра — значит покупка: вкладок две, третьей («всё сразу») нет.
  const deal: 'sale' | 'rent' = f.deal ?? 'sale';
  const supabase = await createClient();
  const order = SORTS.find((s) => s.key === f.sort) ?? SORTS[0];

  // Только витрина. В ней нет ни комиссии, ни агента, ни собственника.
  let query = supabase
    .from('public_catalog_v')
    .select('*', { count: 'exact' })
    .order(order.column, { ascending: order.asc, nullsFirst: false })
    .range((f.page - 1) * CATALOG_PAGE_SIZE, f.page * CATALOG_PAGE_SIZE - 1);

  query = query.eq('deal_type', deal);
  if (f.kind) query = query.eq('kind', f.kind);
  if (f.zone) query = query.eq('zone', f.zone);
  if (f.rooms) query = query.eq('rooms', f.rooms);
  if (f.priceMin != null) query = query.gte('price', f.priceMin);
  if (f.priceMax != null) query = query.lte('price', f.priceMax);
  if (f.q) for (const token of searchTokens(f.q)) query = query.or(tokenFilter(token));

  // Все опубликованные объекты — по ним строится строка районов под
  // пультом поиска. Без фильтров: это состояние каталога целиком.
  const { data: all } = await supabase
    .from('public_catalog_v')
    .select('zone, deal_type')
    .limit(1000);
  const { data, count, error } = await query;
  const rows = (data ?? []) as Row[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  // Районы, в которых реально есть объекты, по убыванию числа объектов:
  // показывать пустой район — обманывать нажатие.
  const byZone = new Map<string, number>();
  for (const r of all ?? []) {
    if (r.deal_type !== deal) continue;
    const z = r.zone as string | null;
    if (z) byZone.set(z, (byZone.get(z) ?? 0) + 1);
  }
  const zones = [...byZone.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([z]) => z);

  const sortLabel: Record<string, string> = {
    fresh: d.sortFresh, cheap: d.sortCheap, big: d.sortBig,
  };

  return (
    <>
      <CatalogHeader lang={lang} />

      <section className="hero">
        <HeroArt />
        <div className="hero-in wrap">
          <span className="eyebrow">Liberterra · {d.city}</span>
          <h1>{d.heroTitle} <em>{d.heroEm}</em></h1>
        </div>
      </section>

      <div className="wrap">
        <Search lang={lang} f={f} deal={deal} />

        {/* Районы строкой: самый частый первый шаг — «покажите, что есть
            в Асанбае». Это ссылки, а не украшение. */}
        {zones.length > 0 ? (
          <div className="zonerow">
            {zones.map((z, i) => (
              <Link key={z} href={catalogHref(lang, { ...f, zone: z }, 1)}
                    className="zone" style={{ '--i': i } as React.CSSProperties}
                    aria-current={f.zone === z ? 'true' : undefined}>
                {z}
              </Link>
            ))}
            {f.zone ? (
              <Link href={catalogHref(lang, { ...f, zone: null }, 1)} className="zone zone-off">
                {d.reset}
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="strip">
          <h2>
            {deal === 'rent' ? d.forRent : d.forSale}
          </h2>
          <span className="found">{error ? d.catalogDown : d.objectsCount(total)}</span>
          <div className="sorts">
            {SORTS.map((s) => (
              <Link key={s.key} className="sort" href={sortHref(lang, f, s.key)}
                    aria-current={f.sort === s.key ? 'true' : undefined}>
                {sortLabel[s.key]}
              </Link>
            ))}
          </div>
        </div>

        <div className="grid">
          {error ? (
            <p className="none error">{error.message}</p>
          ) : rows.length === 0 ? (
            <p className="none">{hasAnyFilter(f) ? d.nothingFound : d.nothingYet}</p>
          ) : (
            rows.map((o, i) => {
              const photo = firstPhoto(o.photos);
              const days = daysSince(o.actual_at);
              const fresh = freshWordIn(lang, days);
              const facade = <Facade o={o} alt={d.drawingAlt} />;
              const kind = kindName(lang, o.kind);
              return (
                <Link className="item" key={o.id} href={`/${lang}/objects/${o.id}`}
                      style={{ '--i': i } as React.CSSProperties}>
                  <Stair />
                  <div className="pic">
                    {photo ? <Photo src={photo} fallback={facade} /> : facade}
                    {/* На фотографии ровно один бейдж — тип сделки. Второй
                        превращал пёструю фотографию в кашу, а свежесть всё
                        равно повторялась строкой ниже. */}
                    <div className="flags">
                      <span className="flag deal">
                        {o.deal_type === 'sale' ? d.sale : d.rent}
                      </span>
                    </div>
                  </div>
                  <div className="info">
                    <span className="price-row">
                      <span className="price num">
                        {publicMoney(lang, o.price, o.currency)}
                        {o.deal_type === 'rent' ? <small>{d.perMonth}</small> : null}
                      </span>
                      {/* Отметка подтверждения — единственная, за которой есть
                          данные: её держит инвариант 5, а не маркетинг.
                          Галочка, а не точка: «сегодня» рядом с точкой не
                          говорит, что именно произошло сегодня. Полная
                          фраза остаётся для экранного диктора. */}
                      <span className="ok-mark" title={`${d.confirmedBy} ${fresh}`}>
                        <Check />
                        <span aria-hidden="true">{fresh}</span>
                        <span className="sr">{d.confirmedBy} {fresh}</span>
                      </span>
                    </span>
                    <span className="addr">{o.address}</span>
                    <div className="facts">
                      <span className="fact">{kind.charAt(0).toUpperCase() + kind.slice(1)}</span>
                      {o.zone ? <span className="fact">{o.zone}</span> : null}
                      {o.rooms ? <span className="fact num">{o.rooms} {d.roomsShort}</span> : null}
                      {o.area ? <span className="fact num">{o.area} {d.sqm}</span> : null}
                      {o.floor ? (
                        <span className="fact num">
                          {d.floorShort} {o.floor}{o.floors_total ? ` ${d.floorOf} ${o.floors_total}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </div>

        {pages > 1 ? (
          <div className="pager">
            <span className="key">{d.pageOf(f.page, pages)}</span>
            {f.page > 1 ? <Link href={catalogHref(lang, f, f.page - 1)}>{d.back}</Link> : null}
            {f.page < pages ? <Link href={catalogHref(lang, f, f.page + 1)}>{d.forward}</Link> : null}
          </div>
        ) : null}
        <CityMap lang={lang} f={f} counts={byZone}
                 title={d.mapTitle} hint={d.mapHint} empty={d.mapEmpty} />
      </div>

      <RequestPitch lang={lang} />

      <CatalogFooter lang={lang} />
    </>
  );
}
