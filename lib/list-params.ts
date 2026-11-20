/**
 * Разбор фильтров из строки запроса.
 *
 * Фильтры живут в URL, а не в состоянии компонента: так ссылку можно
 * отправить коллеге, а перезагрузка страницы не сбрасывает подбор условий.
 */
export const PAGE_SIZE = 20;

export type Filters = {
  deal: 'rent' | 'sale' | null;
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
    zone: one('zone')?.trim() || null,
    state: pick(one('state'), STATES),
    status: pick(one('status'), REQ_STATUSES),
    q: one('q')?.trim() || null,
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
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

export const day = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleDateString('ru-RU', { dateStyle: 'medium' });
