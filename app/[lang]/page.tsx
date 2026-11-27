import Link from 'next/link';
import type { Metadata } from 'next';
import {
  catalogCities, catalogCount, catalogCurrencies, catalogPage, catalogRate,
  catalogZoneCounts,
} from '@/lib/db/catalog';
import { GEO, citiesOf, regionOf, zonesOf } from '@/lib/geo';
import {
  CATALOG_PAGE_SIZE, parseCatalogFilters, catalogHref, sortHref, hasAnyFilter,
  firstPhoto, daysSince, moneySign, priceView,
  SORTS, publicMoney, type CatalogFilters,
} from '@/lib/catalog-params';
import { thumbOf } from '@/lib/photo-url';
import type { Money } from '@/lib/fx';
import { t, kindName, freshWordIn, LANGS, isLang, type Lang, placeName } from '@/lib/i18n';
import { CatalogHeader } from '../CatalogHeader';
import { HeroArt } from '../HeroArt';
import { FindButton } from '../FindButton';
import { GeoPick, type GeoData } from '../GeoPick';
import { RequestPitch } from '../RequestPitch';
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
  city: string;
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

function Search({ lang, f, deal, geo, currencies, money }: {
  lang: Lang; f: CatalogFilters; deal: 'sale' | 'rent'; geo: GeoData;
  /** Валюты каталога: одна — подписываем ею поле цены, несколько — нечем. */
  currencies: string[];
  /** Выбранная валюта показа, если курс известен. */
  money: Money | null;
}) {
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
          {/* Где искать: регион, город, район — три связанных поля, и
              все три списками, без строки ввода. Строкой человек пишет
              «джал», «Джал-23» и «Jal», а в карточке стоит «Джал», и три
              написания из четырёх не находили ничего. Районов у города
              четыре десятка, и набрать «ас» быстрее, чем искать
              «Асанбай» глазами.

              Город показывается, только когда их больше одного: выбор из
              одного пункта ничего не решает, а место на пульте занимает.
              При этом спрятать город в складку «ещё» нельзя — когда
              городов несколько, это первое, что человек выбирает, а не
              уточнение к поиску. */}
          <GeoPick value={{ region: f.region, city: f.city, zone: f.zone }}
                   regions={geo.regions} citiesOf={geo.cities} zonesOf={geo.zones}
                   counts={geo.counts}
                   regionLabel={d.regionLabel} cityLabel={d.cityLabel}
                   zoneLabel={d.zoneLabel} anyLabel={d.anyKind}
                   searchHint={d.zoneSearch} emptyHint={d.zoneNone} />
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
            {/* Валюта в подписи, а не в подсказке: подсказка исчезает,
                как только человек начинает набирать, и ровно тогда
                вопрос «это доллары или сомы» и возникает. */}
            {/* Валюта поля — выбранная человеком, если выбор возможен;
                иначе единственная валюта каталога. Поле без валюты
                оставляет гадать, вводить 800 или 70 000. */}
            <label htmlFor="to">
              {d.priceTo}
              {money ? `, ${moneySign(lang, money)}`
                : currencies.length === 1 ? `, ${moneySign(lang, currencies[0]!)}` : ''}
            </label>
            <input id="to" name="to" type="number" min={0} step={1000} placeholder={d.priceHint}
                   inputMode="numeric" defaultValue={f.priceMax ?? ''} />
          </div>
          <FindButton lang={lang} deal={deal} />
        </div>

        {/* Нижняя граница цены нужна меньшинству, но нужна всерьёз.
            Складкой, а не полем на пульте: длинный пульт пугает. */}
        <details className="more" open={f.priceMin != null}>
          <summary>{d.moreFilters}</summary>
          <div className="row sub">
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
  // Только витрина: в ней нет ни комиссии, ни агента, ни собственника.
  // Это свойство не страницы, а модуля — состав колонок задан там одним
  // списком, и дописать в него «ведёт» мимо рецензии нельзя.
  // Регион — свойство города, а не объекта: фильтр по региону
  // разворачивается в список его городов. Город выбран — регион уже не
  // нужен: город точнее.
  const regionCities = f.region && !f.city ? citiesOf(f.region) : null;

  let total = 0;
  let rows: Row[] = [];
  let failed = false;

  // Курс — до выборки: от него зависят и отбор по цене, и порядок.
  // Нет курса — валюта показа не выбирается вовсе, и всё остаётся как
  // было: цены в своей валюте, сравнение по сырым числам.
  const fx = await catalogRate().catch(() => null);
  const rate = fx?.som_per_unit ?? null;
  const money: Money | null = rate ? (f.money ?? 'USD') : null;

  try {
    const page = await catalogPage({
      deal,
      kind: f.kind,
      city: f.city,
      cities: regionCities,
      zone: f.zone,
      rooms: f.rooms,
      priceMin: f.priceMin,
      priceMax: f.priceMax,
      money,
      rate,
      sort: f.sort,
      page: f.page,
      pageSize: CATALOG_PAGE_SIZE,
    });
    rows = page.items;
    total = page.total;
  } catch {
    // Каталог должен сказать «не открылся», а не упасть белой страницей:
    // человек пришёл смотреть квартиры, а не читать стек вызовов.
    failed = true;
  }

  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));

  // Районы, в которых реально есть объекты, по убыванию числа: показывать
  // пустой район — обманывать нажатие. Те же числа идут на карту города.
  // Города нужны даже когда выдача не открылась: пульт должен выглядеть
  // одинаково, иначе при сбое каталога у человека молча пропадёт фильтр.
  // Сколько объектов в ДРУГОЙ вкладке — с теми же фильтрами.
  //
  // Зачем. Человек приходит на «Купить», видит ноль и уходит, хотя в
  // аренде объект есть. Переключать вкладку за него нельзя: он мог прийти
  // по ссылке, и подмена вкладки сделала бы ссылку неповторимой. Поэтому
  // не подмена, а строка «а в другой вкладке сейчас N» с переходом —
  // решает по-прежнему человек, но теперь зная.
  const other: 'sale' | 'rent' = deal === 'sale' ? 'rent' : 'sale';
  const otherCount = failed || rows.length > 0 ? 0 : await catalogCount({
    deal: other, kind: f.kind, city: f.city, zone: f.zone, rooms: f.rooms,
    priceMin: f.priceMin, priceMax: f.priceMax, money, rate,
  }).catch(() => 0);

  // Валюта для подписи поля «цена до». Одна на весь каталог — подписываем
  // ею; несколько — подписывать нечем, и выбирать за человека нельзя.
  const currencies = failed ? [] : await catalogCurrencies();

  const cities = failed ? [] : await catalogCities();
  const manyCities = cities.length > 1;


  const zoneCounts = failed ? [] : await catalogZoneCounts(deal, f.city, regionCities);

  // Словарь для пульта: регионы, города каждого региона, районы каждого
  // города. К словарным названиям подмешиваются те, что встретились в
  // самих объявлениях: агент мог написать в карточке посёлок, которого
  // в словаре нет, и потерять такие объекты нельзя.
  //
  // Числа — только у районов: сколько объектов сейчас в районе, видно
  // из выдачи, и это отвечает на вопрос «стоит ли нажимать». У города
  // и региона такого числа нет, и выдумывать его незачем.
  const geoCities: Record<string, string[]> = {};
  for (const r of GEO) geoCities[r.name] = r.cities.map((c) => c.name);
  for (const city of cities) {
    const r = regionOf(city) ?? d.otherPlaces;
    const list = geoCities[r] ?? (geoCities[r] = []);
    if (!list.includes(city)) list.push(city);
  }

  const shown = f.city ?? (cities.length === 1 ? cities[0] : null);
  const geoZones: Record<string, string[]> = {};
  if (shown) {
    const order = zonesOf(shown);
    const extra = zoneCounts.map((z) => z.zone).filter((z) => !order.includes(z));
    if (f.zone && !order.includes(f.zone) && !extra.includes(f.zone)) extra.push(f.zone);
    geoZones[shown] = [...order, ...extra.sort((a, b) => a.localeCompare(b, 'ru'))];
  }

  const geo = {
    regions: Object.keys(geoCities),
    cities: geoCities,
    zones: geoZones,
    counts: Object.fromEntries(zoneCounts.map((z) => [z.zone, z.n])),
  };

  // Строкой над выдачей — самые населённые районы: это быстрый путь,
  // а не полный список, полный живёт в поле «Район» на пульте.
  const zones = zoneCounts.slice(0, 8).map((z) => z.zone);

  const sortLabel: Record<string, string> = {
    fresh: d.sortFresh, cheap: d.sortCheap, big: d.sortBig,
  };

  return (
    <>
      <CatalogHeader lang={lang} money={money} />

      <section className="hero">
        <HeroArt />
        <div className="hero-in wrap">
          <span className="eyebrow">Liberterra · {placeName(cities, d)}</span>
          <h1>{d.heroTitle} <em>{d.heroEm}</em></h1>
        </div>
      </section>

      <div className="wrap">
        <Search lang={lang} f={f} deal={deal} geo={geo} currencies={currencies}
                money={money} />

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
          <span className="found">{failed ? d.catalogDown : d.objectsCount(total)}</span>
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
          {failed ? (
            <p className="none error">{d.catalogDown}</p>
          ) : rows.length === 0 ? (
            /* Пустая выдача — развилка, а не тупик. Голая строка «ничего
               нет» читается как неработающий сервис; здесь же сказано,
               что делать дальше, и есть куда нажать. */
            <div className="none-card">
              {/* «Пока нет опубликованных объектов» рядом со строкой «а в
                  другой вкладке сейчас 1» — прямое противоречие: значит
                  объекты есть. Когда дело во вкладке, так и говорим. */}
              <p className="none">
                {hasAnyFilter(f) ? d.nothingFound
                  : otherCount > 0 ? d.emptyTab
                    : d.nothingYet}
              </p>
              {otherCount > 0 ? (
                <p className="other-deal">
                  {d.otherDeal(otherCount)}{' '}
                  <Link href={catalogHref(lang, { ...f, deal: other }, 1)}>
                    {d.otherDealGo} →
                  </Link>
                </p>
              ) : null}
              <p className="ask">{d.emptyAsk}</p>
              <Link href={`/${lang}/request`} className="pitch-go">
                {d.emptyAskGo}
              </Link>
            </div>
          ) : (
            rows.map((o, i) => {
              // В списке — миниатюра. Карточка показывает снимок размером
              // с ладонь, а на странице каталога их десяток: полные
              // снимки стоили бы посетителю мегабайты за то, чего он не
              // увидит. На странице самого объекта берётся полный.
              const photo = thumbOf(firstPhoto(o.photos) ?? '') || null;
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
                        {priceView(lang, o.price, o.currency, money, rate).main}
                        {o.deal_type === 'rent' ? <small>{d.perMonth}</small> : null}
                      </span>
                      {/* Цена из объявления — рядом, мелко, и только
                          когда крупное число получено пересчётом. */}
                      {priceView(lang, o.price, o.currency, money, rate).note ? (
                        <span className="price-orig">
                          {priceView(lang, o.price, o.currency, money, rate).note}
                          {' '}{d.priceFromAd}
                        </span>
                      ) : null}
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
                      {/* Город — только когда городов в каталоге несколько.
                          То же правило, что и у фильтра: «Бишкек» на каждой
                          из десяти карточек это десять раз одно и то же
                          слово, которое ничего не различает. А когда
                          городов несколько, без него два одинаковых адреса
                          не различить вовсе. */}
                      {manyCities ? <span className="fact">{o.city}</span> : null}
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
      </div>

      <RequestPitch lang={lang} />

      <CatalogFooter lang={lang} />
    </>
  );
}
