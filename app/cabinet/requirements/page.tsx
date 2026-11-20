import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { PAGE_SIZE, parseFilters, money, day } from '@/lib/list-params';
import { Pager } from '../Pager';

export const metadata = { title: 'Потребности' };

type Row = {
  id: string;
  deal_type: 'rent' | 'sale';
  budget_min: number | null;
  budget_max: number | null;
  zones: string[];
  rooms: number[];
  deadline: string | null;
  requirements_text: string | null;
  status: string;
  agent_name: string | null;
  client_name: string | null;
  matches_count: number;
  showings_count: number;
  deals_count: number;
};

const STATUS_RU: Record<string, string> = {
  new: 'новая',
  qualified: 'квалифицирована',
  in_showings: 'в показах',
  in_deal: 'в сделке',
  closed: 'закрыта',
  lost: 'отвал',
};

export default async function RequirementsList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const f = parseFilters(await searchParams);
  const supabase = await createClient();

  let query = supabase
    .from('requirement_list_v')
    .select('*', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE - 1);

  if (f.deal) query = query.eq('deal_type', f.deal);
  if (f.status) query = query.eq('status', f.status);
  if (f.zone) query = query.contains('zones', [f.zone]);
  if (f.q) query = query.ilike('requirements_text', `%${f.q}%`);

  const { data, count, error } = await query;

  if (error) {
    return (
      <>
        <h1>Потребности</h1>
        <p className="error">{error.message}</p>
      </>
    );
  }

  const rows = (data ?? []) as Row[];

  return (
    <>
      <h1>Потребности</h1>
      <p className="sub">Всего {count ?? 0}. Клиент виден тем, кому он положен.</p>

      <form className="filters" method="get">
        <input name="q" type="search" placeholder="по тексту требований" defaultValue={f.q ?? ''} />
        <select name="deal" defaultValue={f.deal ?? ''}>
          <option value="">сделка: любая</option>
          <option value="sale">покупка</option>
          <option value="rent">аренда</option>
        </select>
        <select name="status" defaultValue={f.status ?? ''}>
          <option value="">статус: любой</option>
          {Object.entries(STATUS_RU).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input name="zone" type="text" placeholder="зона" defaultValue={f.zone ?? ''} />
        <button type="submit">Фильтр</button>
        {f.deal || f.status || f.zone || f.q ? (
          <Link href="/cabinet/requirements" className="key">сбросить</Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          {count === 0 && !f.deal && !f.status && !f.zone && !f.q
            ? 'Потребностей пока нет.'
            : 'Под эти условия ничего не подошло. Попробуйте ослабить фильтр.'}
        </p>
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="row">
              <Link href={`/cabinet/requirements/${r.id}`}>
                <strong>
                  {money(r.budget_min)} – {money(r.budget_max)}
                </strong>
              </Link>
              <span className="tag">{STATUS_RU[r.status] ?? r.status}</span>
              <span className="key">{r.deal_type === 'sale' ? 'покупка' : 'аренда'}</span>
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">клиент</span>
              {r.client_name ? (
                <span>{r.client_name}</span>
              ) : (
                <span className="hidden-contact">скрыт</span>
              )}
              <span className="key">ведёт</span>
              <span>{r.agent_name ?? '—'}</span>
              {r.deadline ? (
                <>
                  <span className="key">срок</span>
                  <span>{day(r.deadline)}</span>
                </>
              ) : null}
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              {r.zones?.length ? <span className="key">{r.zones.join(', ')}</span> : null}
              {r.rooms?.length ? <span>{r.rooms.join(', ')} комн.</span> : null}
              <span className="key">подборов</span>
              <span>{r.matches_count}</span>
              {r.showings_count > 0 ? (
                <span className="key">показов {r.showings_count}</span>
              ) : null}
              {r.deals_count > 0 ? <span className="tag">в сделке</span> : null}
            </div>

            {r.requirements_text ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span>{r.requirements_text}</span>
              </div>
            ) : null}
          </div>
        ))
      )}

      <Pager base="/cabinet/requirements" filters={f} total={count ?? 0} />
    </>
  );
}
