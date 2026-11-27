import 'server-only';
import { all, batch, newId, now, stmt } from './sql';
import { searchText } from './normalize';
import { MINOR } from './money';
import type { DealType, Kind, MarketCard } from '@/lib/market/house-kg';

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
