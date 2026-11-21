/**
 * Фильтры публичного каталога.
 *
 * Отдельно от lib/list-params.ts намеренно: там фильтры кабинета, среди них
 * состояние публикации и статус потребности — наружу им нельзя. Общий модуль
 * рано или поздно протащил бы кабинетное поле в публичный запрос.
 *
 * Всё живёт в строке запроса: ссылкой на подборку можно поделиться, а робот
 * поисковика видит те же страницы, что и человек.
 */
export const CATALOG_PAGE_SIZE = 12;

export type CatalogSort = 'fresh' | 'cheap' | 'big';

export const SORTS: { key: CatalogSort; label: string; column: string; asc: boolean }[] = [
  // «Свежие» — по дате подтверждения, а не по дате публикации: объявление,
  // которое агент подтвердил вчера, полезнее того, что висит с лета.
  { key: 'fresh', label: 'Сначала свежие', column: 'actual_at', asc: false },
  { key: 'cheap', label: 'Дешевле', column: 'price', asc: true },
  { key: 'big', label: 'Больше площади', column: 'area', asc: false },
];

export type CatalogFilters = {
  deal: 'rent' | 'sale' | null;
  kind: string | null;
  zone: string | null;
  rooms: number | null;
  priceMin: number | null;
  priceMax: number | null;
  q: string | null;
  sort: CatalogSort;
  page: number;
};

const DEALS = ['rent', 'sale'];
const KINDS = ['flat', 'room', 'house', 'townhouse', 'land', 'commercial', 'garage'];

/**
 * Все значения object_kind из схемы. Список обязан совпадать с перечислением
 * в базе целиком: пропущенный вид показывался бы посетителю по-английски и
 * не находился бы фильтром. Совпадение проверяет tests/check-public.sh.
 */
export const KIND_RU: Record<string, string> = {
  flat: 'квартира',
  room: 'комната',
  house: 'дом',
  townhouse: 'таунхаус',
  land: 'участок',
  commercial: 'коммерческая',
  garage: 'гараж',
};

const num = (v: string | undefined) => {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseCatalogFilters(
  sp: Record<string, string | string[] | undefined>,
): CatalogFilters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const page = Number.parseInt(one('page') ?? '1', 10);
  const pick = (v: string | undefined, allowed: string[]) =>
    v && allowed.includes(v) ? v : null;

  return {
    deal: pick(one('deal'), DEALS) as CatalogFilters['deal'],
    kind: pick(one('kind'), KINDS),
    zone: one('zone')?.trim() || null,
    rooms: num(one('rooms')),
    priceMin: num(one('from')),
    priceMax: num(one('to')),
    q: one('q')?.trim() || null,
    sort: (SORTS.some((s) => s.key === one('sort')) ? one('sort') : 'fresh') as CatalogSort,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Та же подборка с другой сортировкой. */
export function sortHref(f: CatalogFilters, sort: CatalogSort) {
  return catalogHref({ ...f, sort }, 1);
}

/** Та же подборка, другая страница. */
export function catalogHref(f: CatalogFilters, page: number) {
  const p = new URLSearchParams();
  if (f.deal) p.set('deal', f.deal);
  if (f.kind) p.set('kind', f.kind);
  if (f.zone) p.set('zone', f.zone);
  if (f.rooms) p.set('rooms', String(f.rooms));
  if (f.priceMin != null) p.set('from', String(f.priceMin));
  if (f.priceMax != null) p.set('to', String(f.priceMax));
  if (f.q) p.set('q', f.q);
  if (f.sort !== 'fresh') p.set('sort', f.sort);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `/?${qs}` : '/';
}

export const hasAnyFilter = (f: CatalogFilters) =>
  Boolean(f.deal || f.kind || f.zone || f.rooms || f.priceMin != null || f.priceMax != null || f.q);

/**
 * Первая фотография объекта. В базе photos — массив объектов {url}, поэтому
 * сюда же стекается защита от мусора: пустого массива, элемента без url и
 * ссылки не по http.
 */
export function firstPhoto(photos: unknown): string | null {
  if (!Array.isArray(photos)) return null;
  for (const p of photos) {
    const url = typeof p === 'string' ? p : (p as { url?: unknown })?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

export function allPhotos(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => (typeof p === 'string' ? p : (p as { url?: unknown })?.url))
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
}

/**
 * Условие поиска по адресу и району для PostgREST .or().
 *
 * Две вещи, которые ломались на живых данных.
 *
 * 1. Запятая. В .or() она разделяет условия, поэтому запрос «Чүй, кв» уезжал
 *    в PostgREST как два куска и возвращал «failed to parse logic tree» —
 *    человек видел пустой каталог вместо своей улицы. Значение берётся в
 *    кавычки, внутри экранируются кавычка и обратная косая.
 *
 * 2. Кыргызские буквы. Адрес в базе «Чүй», а человек набирает «Чуй». ilike
 *    регистр сглаживает, а ү и у — разные буквы, и совпадения не было.
 *    Ищем сразу по нескольким написаниям. Лишние варианты ничего не портят:
 *    они лишь добавляют условия через ИЛИ и никогда не сужают выдачу.
 */
const KG_TO_RU: Record<string, string> = { 'ү': 'у', 'ө': 'о', 'ң': 'н', 'Ү': 'У', 'Ө': 'О', 'Ң': 'Н' };
const RU_TO_KG: Record<string, string> = { 'у': 'ү', 'о': 'ө', 'н': 'ң', 'У': 'Ү', 'О': 'Ө', 'Н': 'Ң' };

const swap = (s: string, map: Record<string, string>) =>
  s.replace(/./gu, (ch) => map[ch] ?? ch);

export function searchVariants(q: string): string[] {
  return [...new Set([q, swap(q, KG_TO_RU), swap(q, RU_TO_KG)])];
}

/**
 * Запрос разбивается на слова, и каждое должно найтись. Подстрочный поиск
 * целиком тут бесполезен: адрес в базе «Чүй 120, кв. 5», а человек набирает
 * «Чуй кв 5» — такой подстроки в адресе нет, и выдача была пустой.
 *
 * Слов берём не больше пяти: это уже точный запрос, а каждое добавляет
 * условия в URL, который PostgREST принимает не бесконечной длины.
 */
export function searchTokens(q: string): string[] {
  return q
    .split(/[\s,;]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 5);
}

/** Условие для одного слова: адрес или район, во всех написаниях. */
export function tokenFilter(token: string): string {
  const quoted = (v: string) => `"%${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`;
  return searchVariants(token)
    .flatMap((v) => [`address.ilike.${quoted(v)}`, `zone.ilike.${quoted(v)}`])
    .join(',');
}

/**
 * Сколько дней назад агент подтверждал объект. Инвариант 5 держит actual_at
 * в актуальном состоянии, и это единственное, чем публичный каталог может
 * доказать посетителю, что объявление живое.
 */
export function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export function freshWord(days: number): string {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  const d = days % 10, h = days % 100;
  const word = d === 1 && h !== 11 ? 'день' : d >= 2 && d <= 4 && (h < 10 || h >= 20) ? 'дня' : 'дней';
  return `${days} ${word} назад`;
}

/** Склонение для счётчика найденного. */
export function objectsWord(n: number): string {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return 'объект';
  if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return 'объекта';
  return 'объектов';
}

/**
 * Цена для публичной части: «85 000 $», «38 000 сом».
 *
 * В кабинете цена подписана кодом валюты — там это точнее, а посетителю
 * привычнее знак. Пробел между тысячами неразрывный, иначе число ломается
 * по строкам. Правило из дизайн-системы: «1 500 000 сом».
 */
export function publicMoney(v: number, currency: string): string {
  const n = new Intl.NumberFormat('ru-RU').format(v).replace(/\u00A0|\s/g, '\u00A0');
  if (currency === 'USD') return `${n}\u00A0$`;
  if (currency === 'KGS') return `${n}\u00A0сом`;
  return `${n}\u00A0${currency}`;
}

/** Тип объекта с заглавной: в начале строки «Квартира · Центр». */
export const kindTitle = (kind: string) => {
  const ru = KIND_RU[kind] ?? kind;
  return ru[0].toUpperCase() + ru.slice(1);
};
