/**
 * Разбор фильтров из строки запроса.
 *
 * Фильтры живут в URL, а не в состоянии компонента: так ссылку можно
 * отправить коллеге, а перезагрузка страницы не сбрасывает подбор условий.
 */
export const PAGE_SIZE = 20;

/**
 * Источник объекта в кабинете: чьи объекты показывать.
 *
 * Живёт только в CRM. В публичном каталоге такой возможности нет и быть не
 * должно: каталогом пользуются не только агенты, и внутреннее устройство
 * агентства их не касается.
 *
 * «Свои» — где ответственный я. Ответственный — listing-агент активного
 * мандата, а у черновика без мандата — тот, кто его завёл.
 */
export type Source = 'me' | 'org' | 'other' | string | null;

export type Dir = 'asc' | 'desc';

export type Filters = {
  deal: 'rent' | 'sale' | null;
  /** Колонка сортировки. Проверяется не здесь, а белым списком запроса. */
  sort: string | null;
  dir: Dir;
  role: string | null;
  src: Source;
  zone: string | null;
  state: string | null;
  status: string | null;
  q: string | null;
  page: number;
};

const DEALS = ['rent', 'sale'];
const STATES = ['draft', 'published', 'withdrawn'];
const REQ_STATUSES = ['new', 'qualified', 'in_showings', 'in_deal', 'closed', 'lost'];

const pick = (v: string | undefined, allowed: string[]) =>
  v && allowed.includes(v) ? v : null;

export function parseFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const page = Number.parseInt(one('page') ?? '1', 10);

  return {
    deal: pick(one('deal'), DEALS) as Filters['deal'],
    // Имя колонки сюда проходит любое: разбирать его здесь значило бы
    // держать список колонок в двух местах. Единственный белый список —
    // в запросе, он же и защищает от подстановки в SQL.
    sort: one('sort')?.trim() || null,
    dir: one('dir') === 'asc' ? 'asc' : 'desc',
    role: one('role')?.trim() || null,
    zone: one('zone')?.trim() || null,
    state: pick(one('state'), STATES),
    status: pick(one('status'), REQ_STATUSES),
    q: one('q')?.trim() || null,
    src: one('src')?.trim() || null,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Ссылка с тем же набором фильтров и другой страницей. */
export function pageHref(base: string, f: Filters, page: number) {
  const p = new URLSearchParams();
  if (f.deal) p.set('deal', f.deal);
  if (f.zone) p.set('zone', f.zone);
  if (f.state) p.set('state', f.state);
  if (f.status) p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  if (f.src) p.set('src', f.src);
  if (f.role) p.set('role', f.role);
  if (f.sort) { p.set('sort', f.sort); p.set('dir', f.dir); }
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

export const day = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleDateString('ru-RU', { dateStyle: 'medium' });

/**
 * Ссылка на тот же список, отсортированный по колонке.
 *
 * Повторный щелчок по той же колонке переворачивает порядок. Новая колонка
 * начинается с убывания: в CRM первым нужен верх списка — самая дорогая
 * сделка, самый свежий объект, — а не начало алфавита.
 */
export function sortHref(base: string, f: Filters, col: string) {
  const dir: Dir = f.sort === col && f.dir === 'desc' ? 'asc' : 'desc';
  return pageHref(base, { ...f, sort: col, dir, page: 1 }, 1);
}
