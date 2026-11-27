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
import { convert, isMoney, type Money } from './fx';
export const CATALOG_PAGE_SIZE = 12;

export type CatalogSort = 'fresh' | 'cheap' | 'big';

export const SORTS: { key: CatalogSort; column: string; asc: boolean }[] = [
  // «Свежие» — по дате подтверждения, а не по дате публикации: объявление,
  // которое агент подтвердил вчера, полезнее того, что висит с лета.
  { key: 'fresh', column: 'actual_at', asc: false },
  { key: 'cheap', column: 'price', asc: true },
  { key: 'big', column: 'area', asc: false },
];

export type CatalogFilters = {
  deal: 'rent' | 'sale' | null;
  kind: string | null;
  region: string | null;
  city: string | null;
  zone: string | null;
  rooms: number | null;
  priceMin: number | null;
  priceMax: number | null;
  sort: CatalogSort;
  page: number;
  /**
   * Валюта показа. Живёт в адресе вместе с остальными фильтрами, а не в
   * cookie: ссылкой на подборку делятся, и получатель должен увидеть те
   * же цены в той же валюте, что отправитель.
   */
  money: Money | null;
};

const DEALS = ['rent', 'sale'];
export const KINDS = ['flat', 'room', 'house', 'townhouse', 'land', 'commercial', 'garage'];

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
    money: isMoney(one('cur')) ? one('cur') as Money : null,
    deal: pick(one('deal'), DEALS) as CatalogFilters['deal'],
    kind: pick(one('kind'), KINDS),
    region: one('region')?.trim() || null,
    city: one('city')?.trim() || null,
    zone: one('zone')?.trim() || null,
    rooms: num(one('rooms')),
    priceMin: num(one('from')),
    priceMax: num(one('to')),
    sort: (SORTS.some((s) => s.key === one('sort')) ? one('sort') : 'fresh') as CatalogSort,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Та же подборка с другой сортировкой. */
export function sortHref(lang: string, f: CatalogFilters, sort: CatalogSort) {
  return catalogHref(lang, { ...f, sort }, 1);
}

/** Та же подборка, другая страница. */
export function catalogHref(lang: string, f: CatalogFilters, page: number) {
  const p = new URLSearchParams();
  if (f.money) p.set('cur', f.money);
  if (f.deal) p.set('deal', f.deal);
  if (f.kind) p.set('kind', f.kind);
  if (f.region) p.set('region', f.region);
  if (f.city) p.set('city', f.city);
  if (f.zone) p.set('zone', f.zone);
  if (f.rooms) p.set('rooms', String(f.rooms));
  if (f.priceMin != null) p.set('from', String(f.priceMin));
  if (f.priceMax != null) p.set('to', String(f.priceMax));
  if (f.sort !== 'fresh') p.set('sort', f.sort);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `/${lang}?${qs}` : `/${lang}`;
}

export const hasAnyFilter = (f: CatalogFilters) =>
  Boolean(f.deal || f.kind || f.region || f.city || f.zone || f.rooms || f.priceMin != null || f.priceMax != null);

/**
 * Первая фотография объекта. В базе photos — массив объектов {url}, поэтому
 * сюда же стекается защита от мусора: пустого массива, элемента без url и
 * ссылки не по http.
 */
/**
 * Что считается ссылкой на снимок.
 *
 * Кроме чужих адресов принимается собственный путь «/photos/…»: снимки,
 * загруженные в наше хранилище, лежат там, и записывать их абсолютным
 * адресом нельзя — сменится домен, и все объявления покажут пустоту.
 *
 * Всё остальное отбрасывается молча: в этом поле могла оказаться строка
 * из старых данных, и падать из-за неё страница не должна.
 */
function isPhotoUrl(url: unknown): url is string {
  return typeof url === 'string'
    && (/^https?:\/\//i.test(url) || url.startsWith('/photos/'));
}

export function firstPhoto(photos: unknown): string | null {
  if (!Array.isArray(photos)) return null;
  for (const p of photos) {
    const url = typeof p === 'string' ? p : (p as { url?: unknown })?.url;
    if (isPhotoUrl(url)) return url;
  }
  return null;
}

export function allPhotos(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => (typeof p === 'string' ? p : (p as { url?: unknown })?.url))
    .filter(isPhotoUrl);
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

/**
 * Цена для публичной части: «85 000 $», «38 000 сом», «85,000 $».
 *
 * В кабинете цена подписана кодом валюты — там это точнее, а посетителю
 * привычнее знак. Разделитель тысяч берётся по языку: англичанин ждёт
 * запятую, и «85 000» он читает хуже, чем «85,000». Пробел неразрывный,
 * иначе число ломается по строкам. Правило дизайн-системы: «1 500 000 сом».
 *
 * Сама по себе НЕ пересчитывает: цену назвал собственник в своей валюте,
 * и подменить её другим числом нельзя. Пересчёт — дело priceView ниже, и
 * он всегда помечен как пересчёт.
 */
const SOM: Record<string, string> = { ru: 'сом', ky: 'сом', en: 'som', zh: '索姆' };

/**
 * Знак валюты без числа — для подписи поля «цена до».
 *
 * Отдельно от publicMoney, потому что задача другая: там цена объекта, и
 * сом пишется словом рядом с числом; здесь нужен один короткий знак в
 * подписи, где числа нет вовсе.
 */
export function moneySign(lang: string, currency: string): string {
  if (currency === 'USD') return '$';
  if (currency === 'KGS') return SOM[lang] ?? 'KGS';
  return currency;
}

export function publicMoney(lang: string, v: number, currency: string): string {
  const locale = lang === 'en' ? 'en-US' : lang === 'zh' ? 'zh-CN' : 'ru-RU';
  const n = new Intl.NumberFormat(locale).format(v).replace(/\u00A0|\s/g, '\u00A0');
  if (currency === 'USD') return `${n}\u00A0$`;
  if (currency === 'KGS') return `${n}\u00A0${SOM[lang] ?? 'KGS'}`;
  return `${n}\u00A0${currency}`;
}

/**
 * Цена для показа в выбранной человеком валюте.
 *
 * Возвращает две строки. `main` — то, что стоит крупно; `note` — цена из
 * объявления, когда `main` получена пересчётом, и пусто, когда пересчёта
 * не было.
 *
 * Почему пересчёт ВСЕГДА помечен. Собственник назвал цену в своей валюте:
 * 55 000 долларов — это обязательство, 4 810 000 сомов по сегодняшнему
 * курсу — нет. Покажи второе как окончательное, и покупатель придёт с
 * сомами на сделку, которая идёт в долларах, а виновато будет агентство.
 * Поэтому у пересчитанного числа стоит «≈», а рядом — то, что написано в
 * объявлении.
 *
 * Нет курса или валюта третья — пересчёта нет, показывается исходная
 * цена. Это не обеднение: цена остаётся верной, просто не в той валюте,
 * которую выбрали.
 */
export function priceView(
  lang: string,
  price: number,
  currency: string,
  money: Money | null,
  somPerUsd: number | null,
): { main: string; note: string | null } {
  const original = publicMoney(lang, price, currency);
  if (!money || currency === money) return { main: original, note: null };

  const converted = convert(price, currency, money, somPerUsd);
  if (converted === null) return { main: original, note: null };

  // Округление до целого: доли сома и цента в цене квартиры — шум, а в
  // пересчитанном числе ещё и ложная точность.
  return {
    main: `≈\u00A0${publicMoney(lang, Math.round(converted), money)}`,
    note: original,
  };
}
