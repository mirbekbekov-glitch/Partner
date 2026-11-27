import 'server-only';
import { all, batch, from_now, newId, now, one, stmt } from './sql';
import { searchText } from './normalize';
import { MINOR } from './money';
import type { DealType, Kind, MarketCard } from '@/lib/market/house-kg';
import {
  AREA_SPREAD, rateFromPairs, valuate,
  type Comparable, type Valuation, type Widening,
} from '@/lib/market/valuation';
import { resembleAll, type Resemblance } from '@/lib/market/duplicate';

/**
 * Индекс рынка: запись наблюдений за чужими объявлениями.
 *
 * ПОЧЕМУ ЗДЕСЬ МОЖНО ПРАВИТЬ, А В ИМПОРТЕ КАТАЛОГА НЕЛЬЗЯ. Правило
 * «импорт только заводит и никогда не правит» (lib/db/catalog-import.ts)
 * защищает РАБОТУ АГЕНТА: карточку объекта уточнили руками, и ночной
 * прогон не вправе её затирать.
 *
 * Здесь работы агента нет и быть не может. Эти строки — наблюдения:
 * никто их не редактирует, у них нет хозяина, и смысл у них ровно один —
 * говорить, что на рынке сейчас. Поэтому обход ОБЯЗАН обновлять цену и
 * сигналы: не обновив, мы бы считали медиану по прошлогодним ценам.
 *
 * Что при этом не затирается никогда: first_seen_at («когда увидели
 * впервые», из него считается «висит давно») и история цен, в которую
 * можно только дописать.
 */

/** Площадка-источник. Пока одна; вторая добавится строкой, а не ветвлением. */
export const HOUSE_KG = 'house.kg';

/** Итог одного прогона по разделу. */
export type SectionReport = {
  deal: DealType;
  kind: Kind;
  city: string;
  /** Страниц прочитано. */
  pages: number;
  /** Карточек разобрано. */
  cards: number;
  /** Заведено впервые. */
  added: number;
  /** Уже было — обновлено. */
  updated: number;
  /** У скольких цена отличалась от прошлой. */
  priceChanged: number;
  /** Перестало попадаться в выдаче в этом прогоне. */
  gone: number;
  /** Отброшено разбором, с причинами. */
  skipped: Record<string, number>;
};

type Existing = {
  id: string;
  price_usd_minor: number | null;
  price_kgs_minor: number | null;
};

/** Цена в минорные единицы; её отсутствие остаётся отсутствием. */
function minorOf(value: number | null): number | null {
  return value === null ? null : Math.round(value * MINOR);
}

/**
 * Запись карточек одного раздела.
 *
 * Одним батчем на раздел, а не запросом на карточку: D1 выполняет батч
 * транзакцией, и прогон, оборвавшийся посередине, не оставит половину
 * раздела записанной, а половину — нет.
 */
export async function saveCards(
  deal: DealType,
  kind: Kind,
  city: string,
  cards: MarketCard[],
  bumpedAtOf: (card: MarketCard) => string | null,
): Promise<{ added: number; updated: number; priceChanged: number }> {
  if (cards.length === 0) return { added: 0, updated: 0, priceChanged: 0 };

  const ids = cards.map((c) => c.sourceId);
  const known = new Map<string, Existing>();

  // Читаем порциями: список «?, ?, ?» на тысячу значений SQLite не примет.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await all<Existing & { source_id: string }>(
      `select id, source_id, price_usd_minor, price_kgs_minor
         from market_listings
        where source = ? and source_id in (${chunk.map(() => '?').join(', ')})`,
      HOUSE_KG,
      ...chunk,
    );
    for (const row of rows) known.set(row.source_id, row);
  }

  const at = now();
  const statements = [];
  let added = 0;
  let updated = 0;
  let priceChanged = 0;

  for (const card of cards) {
    const usdMinor = minorOf(card.priceUsd);
    const kgsMinor = minorOf(card.priceKgs);
    const was = known.get(card.sourceId);

    if (was) {
      updated++;
      statements.push(stmt(
        `update market_listings
            set url = ?, city = ?, address = ?, rooms = ?, area = ?,
                floor = ?, floors_total = ?,
                price_usd_minor = ?, price_kgs_minor = ?, rent_period = ?,
                seller_kind = ?, seller_name = ?,
                views = ?, favorites = ?, bumped = ?, bumped_text = ?,
                bumped_at = ?, market_note = ?, search_text = ?,
                last_seen_at = ?, gone_at = null
          where id = ?`,
        card.url, card.city ?? city, card.address, card.rooms, card.area,
        card.floor, card.floorsTotal,
        usdMinor, kgsMinor, card.period,
        card.sellerKind, card.sellerName,
        card.views, card.favorites, card.bumped ? 1 : 0, card.bumpedText,
        bumpedAtOf(card), card.marketNote,
        searchText(card.address, card.city ?? city),
        at,
        was.id,
      ));

      // Строка в историю — ТОЛЬКО при изменении цены. Иначе ежедневный
      // прогон за год дал бы 365 одинаковых строк на объявление и ни
      // одного факта сверх первой.
      if (was.price_usd_minor !== usdMinor || was.price_kgs_minor !== kgsMinor) {
        priceChanged++;
        statements.push(stmt(
          `insert into market_prices
             (id, listing_id, price_usd_minor, price_kgs_minor, seen_at)
           values (?, ?, ?, ?, ?)`,
          newId(), was.id, usdMinor, kgsMinor, at,
        ));
      }
      continue;
    }

    added++;
    const id = newId();
    statements.push(stmt(
      `insert into market_listings
         (id, source, source_id, url, deal_type, kind, city, address,
          rooms, area, floor, floors_total,
          price_usd_minor, price_kgs_minor, rent_period,
          seller_kind, seller_name, views, favorites,
          bumped, bumped_text, bumped_at, market_note, search_text,
          first_seen_at, last_seen_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, HOUSE_KG, card.sourceId, card.url, deal, kind,
      card.city ?? city, card.address,
      card.rooms, card.area, card.floor, card.floorsTotal,
      usdMinor, kgsMinor, card.period,
      card.sellerKind, card.sellerName, card.views, card.favorites,
      card.bumped ? 1 : 0, card.bumpedText, bumpedAtOf(card), card.marketNote,
      searchText(card.address, card.city ?? city),
      at, at,
    ));

    // Первая цена пишется сразу: иначе у объявления, которое больше
    // никогда не подешевеет, истории не будет вовсе, и сравнивать
    // будущее снижение станет не с чем.
    statements.push(stmt(
      `insert into market_prices
         (id, listing_id, price_usd_minor, price_kgs_minor, seen_at)
       values (?, ?, ?, ?, ?)`,
      newId(), id, usdMinor, kgsMinor, at,
    ));
  }

  // Батч режется на части: у D1 есть предел числа команд в одной
  // транзакции, а раздел на десяти страницах даёт до восьмисот команд.
  for (let i = 0; i < statements.length; i += 100) {
    await batch(statements.slice(i, i + 100));
  }

  return { added, updated, priceChanged };
}

/**
 * Пометить исчезнувшие: кого не видели в этом прогоне.
 *
 * Строка НЕ УДАЛЯЕТСЯ. Исчезнувшее объявление — это факт о рынке
 * («продали, сняли или кончился срок»), и в оценке оно ещё пригодится:
 * проданное по известной цене честнее говорит о рынке, чем висящее.
 *
 * Снимается пометка сама: если объявление снова попадётся в выдаче,
 * обновление ставит gone_at = null.
 */
export async function markGone(
  deal: DealType,
  kind: Kind,
  city: string,
  startedAt: string,
): Promise<number> {
  const rows = await all<{ id: string }>(
    `select id from market_listings
      where source = ? and deal_type = ? and kind = ? and city = ?
        and gone_at is null and last_seen_at < ?`,
    HOUSE_KG, deal, kind, city, startedAt,
  );

  if (rows.length === 0) return 0;

  const at = now();
  const statements = rows.map((r) =>
    stmt(`update market_listings set gone_at = ? where id = ?`, at, r.id));

  for (let i = 0; i < statements.length; i += 100) {
    await batch(statements.slice(i, i + 100));
  }
  return rows.length;
}

/** Сколько объявлений в индексе сейчас — для отчёта прогона. */
export async function marketSize(): Promise<{ live: number; gone: number }> {
  const rows = await all<{ gone: number; n: number }>(
    `select case when gone_at is null then 0 else 1 end as gone, count(*) as n
       from market_listings group by 1`,
  );
  return {
    live: rows.find((r) => r.gone === 0)?.n ?? 0,
    gone: rows.find((r) => r.gone === 1)?.n ?? 0,
  };
}

/** Что оцениваем. */
export type ValueSpec = {
  deal: DealType;
  kind: Kind;
  city: string;
  /** Район или ориентир словами — как агент его называет. */
  zone: string | null;
  rooms: number | null;
  area: number;
  /** В какой валюте нужен ответ. */
  currency: 'USD' | 'KGS';
  /** Для аренды: месячная или посуточная. */
  period: 'month' | 'day' | null;
};

/** Почему оценки нет. Отказ — это ответ, а не пустота. */
export type NoValue =
  | 'нет площади'
  | 'индекс пуст'
  | 'мало похожих';

export type EstimateResult = {
  valuation: Valuation | null;
  reason: NoValue | null;
  /** Курс, по которому приводились валюты. null — приведения не было. */
  rate: number | null;
  /** Сколько объявлений вообще было в сегменте до сужения. */
  pool: number;
};

/**
 * Сколько дней объявление считается годным для сравнения.
 *
 * Полгода — не «чем больше, тем лучше». Рынок Бишкека за год двигался на
 * заметные проценты, и позапрошлогодняя цена говорит о позапрошлом годе.
 * Но и месяц брать нельзя: по редкой связке за месяц наберётся три
 * объявления, а на трёх медианы не бывает.
 */
const FRESH_DAYS = 180;

type Row = {
  id: string;
  url: string;
  price_usd_minor: number | null;
  price_kgs_minor: number | null;
  area: number;
  rooms: number | null;
  address: string | null;
  seller_kind: 'owner' | 'agency' | 'unknown';
  bumped_at: string | null;
  search_text: string;
};

/**
 * Курс по самим объявлениям: медиана отношения цен там, где площадка
 * назвала обе валюты. Подробно — в lib/market/valuation.ts.
 */
export async function observedRate(): Promise<number | null> {
  const rows = await all<{ price_usd_minor: number; price_kgs_minor: number }>(
    `select price_usd_minor, price_kgs_minor
       from market_listings
      where price_usd_minor is not null and price_kgs_minor is not null
        and gone_at is null
      limit 2000`,
  );
  return rateFromPairs(
    rows.map((r) => ({ usdMinor: r.price_usd_minor, kgsMinor: r.price_kgs_minor })),
  );
}

/** Цена строки в нужной валюте; при нехватке — приведение по курсу. */
function priceIn(row: Row, currency: 'USD' | 'KGS', rate: number | null): number | null {
  if (currency === 'USD') {
    if (row.price_usd_minor !== null) return row.price_usd_minor;
    if (row.price_kgs_minor !== null && rate) return Math.round(row.price_kgs_minor / rate);
    return null;
  }
  if (row.price_kgs_minor !== null) return row.price_kgs_minor;
  if (row.price_usd_minor !== null && rate) return Math.round(row.price_usd_minor * rate);
  return null;
}

/**
 * Оценка объекта по сопоставимым.
 *
 * Выборка сужается ЛЕСТНИЦЕЙ: сперва тот же район и та же комнатность,
 * и только если объявлений не набралось — шаг за шагом шире. Насколько
 * пришлось отойти, возвращается наружу и показывается агенту: оценка «по
 * шести квартирам в том же районе» и «по сорока по всему городу» — это
 * разные оценки, и выдавать их одинаково было бы обманом.
 */
export async function estimate(spec: ValueSpec): Promise<EstimateResult> {
  if (!(spec.area > 0)) {
    return { valuation: null, reason: 'нет площади', rate: null, pool: 0 };
  }

  const since = from_now(-FRESH_DAYS * 24 * 3600_000);
  const rate = await observedRate();

  const rows = await all<Row>(
    `select id, url, price_usd_minor, price_kgs_minor, area, rooms, address,
            seller_kind, bumped_at, search_text
       from market_listings
      where source = ? and deal_type = ? and kind = ? and city = ?
        and gone_at is null and area is not null and last_seen_at >= ?
        and (? is null or rent_period = ?)`,
    HOUSE_KG, spec.deal, spec.kind, spec.city, since,
    spec.period, spec.period,
  );

  if (rows.length === 0) {
    return { valuation: null, reason: 'индекс пуст', rate, pool: 0 };
  }

  const pool: Comparable[] = [];
  for (const row of rows) {
    const priceMinor = priceIn(row, spec.currency, rate);
    if (priceMinor === null || priceMinor <= 0) continue;
    pool.push({
      id: row.id,
      url: row.url,
      priceMinor,
      area: row.area,
      rooms: row.rooms,
      address: row.address,
      sellerKind: row.seller_kind,
      bumpedAt: row.bumped_at,
    });
  }

  const zoneKey = spec.zone ? searchText(spec.zone) : '';
  const byZone = (c: Comparable) =>
    zoneKey === '' || searchText(c.address).includes(zoneKey);

  const low = spec.area * (1 - AREA_SPREAD);
  const high = spec.area * (1 + AREA_SPREAD);
  const byArea = (c: Comparable) => c.area >= low && c.area <= high;

  const sameRooms = (c: Comparable) => spec.rooms === null || c.rooms === spec.rooms;
  const nearRooms = (c: Comparable) =>
    spec.rooms === null || (c.rooms !== null && Math.abs(c.rooms - spec.rooms) <= 1);

  // Лестница: от точного к широкому. Первая ступень, на которой
  // объявлений хватило, и становится ответом.
  const ladder: Array<{ widening: Widening; pick: (c: Comparable) => boolean }> = [
    { widening: 'точно', pick: (c) => byZone(c) && sameRooms(c) && byArea(c) },
    { widening: 'без района', pick: (c) => sameRooms(c) && byArea(c) },
    { widening: 'комнаты ±1', pick: (c) => nearRooms(c) && byArea(c) },
    { widening: 'без комнат', pick: byArea },
    { widening: 'широко', pick: () => true },
  ];

  for (const step of ladder) {
    const picked = pool.filter(step.pick);
    const valuation = valuate(picked, spec.area, step.widening);
    if (valuation) return { valuation, reason: null, rate, pool: pool.length };
  }

  return { valuation: null, reason: 'мало похожих', rate, pool: pool.length };
}

/** Города, по которым в индексе вообще что-то есть. */
export async function marketCities(): Promise<string[]> {
  const rows = await all<{ city: string }>(
    `select city, count(*) as n from market_listings
      where gone_at is null group by city order by n desc`,
  );
  return rows.map((r) => r.city);
}

/** Когда индекс обновлялся в последний раз: без этого оценка безродная. */
export async function marketUpdatedAt(): Promise<string | null> {
  const row = await one<{ at: string | null }>(
    `select max(last_seen_at) as at from market_listings`,
  );
  return row?.at ?? null;
}

/**
 * Что из нашего объекта уже висит на площадке.
 *
 * Отбор здесь широкий нарочно: сузить до «тот же адрес» нельзя — адрес
 * агент и площадка пишут по-разному («Чуй 120» и «ул. Чүй 120/1»).
 * Поэтому база отдаёт всё, что подходит по виду, городу и площади, а
 * сличением занимается lib/market/duplicate.ts, где признаки
 * перечислимы и проверяемы.
 *
 * Типы, которых обход не берёт (коммерция, гараж, таунхаус), сравнивать
 * не с чем: возвращается пусто, и страница об этом говорит прямо.
 */
export async function marketLookalikes(ours: {
  kind: string;
  deal_type: string;
  city: string;
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  price: number;
  currency: string;
}): Promise<{ found: Resemblance[]; comparable: boolean }> {
  const KNOWN: string[] = ['flat', 'room', 'house', 'land'];
  if (!KNOWN.includes(ours.kind)) return { found: [], comparable: false };

  // Площадь гуляет: площадка округляет, агент пишет по документам.
  // Пятнадцать процентов — это запас на такое расхождение, а не на
  // «похожий объект»: похожесть решается уже сличением.
  const low = ours.area === null ? null : ours.area * 0.85;
  const high = ours.area === null ? null : ours.area * 1.15;

  const rows = await all<{
    id: string; url: string; address: string | null; rooms: number | null;
    area: number | null; floor: number | null;
    price_usd_minor: number | null; price_kgs_minor: number | null;
    seller_kind: 'owner' | 'agency' | 'unknown'; seller_name: string | null;
    bumped_at: string | null;
  }>(
    `select id, url, address, rooms, area, floor,
            price_usd_minor, price_kgs_minor, seller_kind, seller_name, bumped_at
       from market_listings
      where source = ? and deal_type = ? and kind = ? and city = ?
        and gone_at is null
        and (? is null or (area is not null and area between ? and ?))
      limit 500`,
    HOUSE_KG, ours.deal_type, ours.kind, ours.city,
    low, low, high,
  );

  const rate = await observedRate();

  return {
    comparable: true,
    found: resembleAll(
      {
        address: ours.address, zone: ours.zone, rooms: ours.rooms,
        area: ours.area, floor: ours.floor, price: ours.price, currency: ours.currency,
      },
      rows.map((r) => ({
        id: r.id,
        url: r.url,
        address: r.address,
        rooms: r.rooms,
        area: r.area,
        floor: r.floor,
        priceUsd: r.price_usd_minor === null ? null : r.price_usd_minor / 100,
        priceKgs: r.price_kgs_minor === null ? null : r.price_kgs_minor / 100,
        sellerKind: r.seller_kind,
        sellerName: r.seller_name,
        bumpedAt: r.bumped_at,
      })),
      rate,
    ),
  };
}
