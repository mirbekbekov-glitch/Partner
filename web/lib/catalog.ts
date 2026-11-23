import { asCatalogRole, asReportRole } from "./db";
import type {
  CatalogFilters,
  CatalogObject,
  DealType,
  ObjectKind,
  SortKey,
} from "./types";

export const PAGE_SIZE = 12;

const KINDS: ObjectKind[] = [
  "flat",
  "room",
  "house",
  "townhouse",
  "land",
  "commercial",
  "garage",
];

const SORTS: Record<SortKey, string> = {
  // По умолчанию свежесть подтверждения, а не дата публикации: покупателю
  // важно, что объект подтверждали вчера, а не что его завели год назад.
  fresh: "actual_at desc nulls last",
  price_asc: "price asc",
  price_desc: "price desc",
  area_desc: "area desc nulls last",
};

function toInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Разбор строки запроса. Всё неизвестное отбрасывается, а не падает. */
export function parseFilters(
  params: Record<string, string | string[] | undefined>,
): CatalogFilters {
  const one = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const deal = one("deal");
  const kind = one("kind");
  const sort = one("sort");
  const page = toInt(one("page"));

  // Строка поиска обрезается и ограничивается: это не полнотекстовый поиск,
  // а «найди по куску адреса», и сто символов ему не нужны.
  const q = one("q")?.trim().slice(0, 60) || null;

  return {
    q,
    deal: deal === "sale" || deal === "rent" ? (deal as DealType) : null,
    kind: KINDS.includes(kind as ObjectKind) ? (kind as ObjectKind) : null,
    zone: one("zone")?.trim() || null,
    rooms: toInt(one("rooms")),
    priceMin: toInt(one("price_min")),
    priceMax: toInt(one("price_max")),
    sort: sort && sort in SORTS ? (sort as SortKey) : "fresh",
    page: page && page > 0 ? page : 1,
  };
}

export type CatalogPage = {
  items: CatalogObject[];
  total: number;
  page: number;
  pages: number;
};

const COLUMNS = `id, kind, deal_type, address, zone, rooms, area, floor,
       floors_total, price, currency, photos, description,
       published_at, actual_at`;

export async function fetchCatalog(f: CatalogFilters): Promise<CatalogPage> {
  const where: string[] = [];
  const args: unknown[] = [];

  const add = (column: string, op: string, value: unknown) => {
    args.push(value);
    where.push(`${column} ${op} $${args.length}`);
  };

  // Адрес или район одним полем — так его ищет человек: «Джал» это район,
  // «Чуй 120» это адрес, и разбирать, что именно он ввёл, незачем.
  //
  // Знаки процента и подчёркивания экранируются: без этого запрос «50%»
  // означал бы «всё, где есть пятёрка и ноль», а одиночное подчёркивание —
  // вообще всё. Подстановка здесь параметром, поэтому это не дыра, а
  // неправильный ответ; но неправильный ответ на поиск хуже пустого.
  // Кыргызские буквы приводятся к русским с обеих сторон сравнения. Найдено
  // проходом в браузере: в базе улица называется «Чүй», человек набирает
  // «Чуй», и поиск отвечал «ничего не найдено» — худший из возможных
  // ответов, потому что объект есть и он на первой странице.
  //
  // translate, а не unaccent: расширения в базе нет, а три буквы прекрасно
  // переводятся списком. ө→о, ү→у, ң→н, и то же для заглавных.
  const KG = "'үөңҮӨҢ', 'уонУОН'";

  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like);
    const n = args.length;
    where.push(
      `(translate(address, ${KG}) ilike translate($${n}, ${KG})` +
        ` or translate(zone, ${KG}) ilike translate($${n}, ${KG}))`,
    );
  }
  if (f.deal) add("deal_type", "=", f.deal);
  if (f.kind) add("kind", "=", f.kind);
  if (f.zone) add("zone", "=", f.zone);
  // «3 комнаты» в объявлениях означает «три и больше»: четырёхкомнатную
  // квартиру ищут тем же фильтром.
  if (f.rooms) add("rooms", ">=", f.rooms);
  if (f.priceMin) add("price", ">=", f.priceMin);
  if (f.priceMax) add("price", "<=", f.priceMax);

  const clause = where.length ? `where ${where.join(" and ")}` : "";
  const offset = (f.page - 1) * PAGE_SIZE;

  return asCatalogRole(async (client) => {
    const counted = await client.query<{ total: string }>(
      `select count(*)::text as total from public_catalog_v ${clause}`,
      args,
    );
    const total = Number.parseInt(counted.rows[0]?.total ?? "0", 10);

    const rows = await client.query<CatalogObject>(
      `select ${COLUMNS}
         from public_catalog_v
         ${clause}
         order by ${SORTS[f.sort]}, id
         limit ${PAGE_SIZE} offset ${offset}`,
      args,
    );

    return {
      items: rows.rows,
      total,
      page: f.page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  });
}

export async function fetchObject(id: string): Promise<CatalogObject | null> {
  // Формат проверяем здесь: иначе невалидный идентификатор уронит запрос
  // ошибкой базы вместо честной страницы «не найдено».
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;

  return asCatalogRole(async (client) => {
    const { rows } = await client.query<CatalogObject>(
      `select ${COLUMNS} from public_catalog_v where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
}

/** Зоны и виды, по которым реально есть объявления. Пустых фильтров не надо. */
export async function fetchFacets(): Promise<{
  zones: string[];
  kinds: ObjectKind[];
}> {
  return asCatalogRole(async (client) => {
    const zones = await client.query<{ zone: string }>(
      `select distinct zone from public_catalog_v
        where zone is not null order by zone`,
    );
    const kinds = await client.query<{ kind: ObjectKind }>(
      `select distinct kind from public_catalog_v order by kind`,
    );
    return {
      zones: zones.rows.map((r) => r.zone),
      kinds: kinds.rows.map((r) => r.kind),
    };
  });
}

/**
 * Похожие предложения: та же сделка, цена в пределах трети.
 * Свой район идёт первым, но не обязателен: требовать совпадения района
 * означало бы пустой блок почти на каждом объекте — в Бишкеке в одном районе
 * и в одной цене редко оказывается больше одного предложения.
 */
export async function fetchSimilar(
  object: CatalogObject,
  limit = 3,
): Promise<CatalogObject[]> {
  return asCatalogRole(async (client) => {
    const { rows } = await client.query<CatalogObject>(
      `select ${COLUMNS}
         from public_catalog_v
        where id <> $1
          and deal_type = $2
          and price between $3::numeric * 0.67 and $3::numeric * 1.33
        order by (zone is distinct from $4::text),
                 abs(price - $3::numeric),
                 actual_at desc nulls last
        limit $5`,
      [object.id, object.deal_type, object.price, object.zone, limit],
    );
    return rows;
  });
}

/** Идентификаторы и даты для карты сайта. */
export async function fetchSitemapRows(): Promise<
  Array<{ id: string; actual_at: string | null }>
> {
  return asCatalogRole(async (client) => {
    const { rows } = await client.query<{ id: string; actual_at: string | null }>(
      `select id, actual_at from public_catalog_v order by actual_at desc nulls last`,
    );
    return rows;
  });
}

/**
 * Отметить открытие карточки.
 *
 * Пишет через `asReportRole`: роль та же пониженная, что у каталога, но
 * транзакция пишущая — ровно как у отчёта собственнику, который так же
 * считает просмотры. Прав на таблицу у роли нет, функция security definer.
 *
 * ЧТО НЕ СЧИТАЕТСЯ. Явные роботы — поисковые обходчики и разворачиватели
 * ссылок в мессенджерах. Их открытия ничего не говорят агенту о спросе, а
 * счётчик с ними отвечал бы на вопрос «часто ли нас обходит Гугл».
 * Заголовок при этом ЧИТАЕТСЯ, но не сохраняется: нам нужно решение, а не
 * запись о посетителе.
 *
 * Ошибка подсчёта не должна ронять страницу: человек пришёл смотреть
 * квартиру, а не наблюдать, как у нас не сложилась статистика.
 */
const ROBOTS = /bot\b|crawler|spider|slurp|facebookexternalhit|preview|embed/i;

export async function noteObjectView(id: string, userAgent: string | null): Promise<void> {
  if (userAgent && ROBOTS.test(userAgent)) return;
  try {
    await asReportRole(async (client) => {
      await client.query("select app.note_object_view($1)", [id]);
    });
  } catch (error) {
    console.error(`не удалось отметить открытие карточки ${id}: ${String(error)}`);
  }
}
