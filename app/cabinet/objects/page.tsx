import Link from 'next/link';
import { objectList } from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { currentAgent } from '@/lib/db/session';
import { PAGE_SIZE, parseFilters, money, day } from '@/lib/list-params';
import { Pager } from '../Pager';

export const metadata = { title: 'Объекты' };

type Row = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  price: number;
  currency: string;
  publication_state: string;
  actual_at: string;
  active_mandate_id: string | null;
  contract_confirmed: boolean | null;
  listing_agent_name: string | null;
  owners: string | null;
  matches_count: number;
  commission_total: number | null;
  responsible_agent_id: string | null;
  responsible_name: string | null;
  responsible_org_id: string | null;
  responsible_org_name: string | null;
};

const STATE_RU: Record<string, string> = {
  draft: 'черновик',
  published: 'опубликован',
  withdrawn: 'снят',
};

export default async function ObjectsList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const f = parseFilters(await searchParams);
  // Кто я — нужно для «моих» и «моей организации».
  const me = await currentAgent();

  // Список коллег для выбора конкретного агента. Видят его все одобренные:
  // это не чувствительные данные, а имена для фильтра.
  const colleagues = await approvedColleagues().catch(() => []);

  // Источник. «Другие» — это не «все, кроме меня»: объект коллеги по моему
  // же агентству остаётся своим.
  const source = f.src === 'me' ? 'mine'
    : f.src === 'org' ? 'org'
    : f.src === 'other' ? 'others'
    : 'all';

  // Конкретный агент: идентификатор приходит из формы, но доверять ему не
  // нужно — фильтр ничего не открывает, видимость решает предикат внутри
  // запроса.
  const agentId = f.src && f.src.includes('-') ? f.src : null;

  let rows: Row[] = [];
  let error: string | null = null;

  try {
    rows = await objectList({
      state: f.state, deal: f.deal, zone: f.zone, q: f.q,
      source, agentId,
    }) as unknown as Row[];
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить объекты.';
  }

  const count = rows.length;

  return (
    <>
      <div className="head">
        <h1>Объекты</h1>
        <Link className="btn" href="/cabinet/objects/new">Новый объект</Link>
      </div>
      <p className="sub">Всего {count ?? 0}. Собственник виден тем, кому он положен.</p>

      <form className="filters" method="get">
        <input name="q" type="search" placeholder="адрес" defaultValue={f.q ?? ''} />
        <select name="deal" defaultValue={f.deal ?? ''}>
          <option value="">сделка: любая</option>
          <option value="sale">продажа</option>
          <option value="rent">аренда</option>
        </select>
        <select name="state" defaultValue={f.state ?? ''}>
          <option value="">состояние: любое</option>
          <option value="draft">черновик</option>
          <option value="published">опубликован</option>
          <option value="withdrawn">снят</option>
        </select>
        <input name="zone" type="text" placeholder="зона" defaultValue={f.zone ?? ''} />
        <select name="src" defaultValue={f.src ?? ''}>
          <option value="">источник: любой</option>
          <option value="me">мои объекты</option>
          {me?.organization_id ? <option value="org">моего агентства</option> : null}
          <option value="other">других агентств</option>
          {(colleagues ?? [])
            .filter((c) => c.id !== me?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>{c.full_name}</option>
            ))}
        </select>
        <button type="submit">Фильтр</button>
        {f.deal || f.state || f.zone || f.q || f.src ? (
          <Link href="/cabinet/objects" className="key">сбросить</Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          {count === 0 && !f.deal && !f.state && !f.zone && !f.q
            ? 'Объектов пока нет.'
            : 'Под эти условия ничего не подошло. Попробуйте ослабить фильтр.'}
        </p>
      ) : (
        rows.map((o) => (
          <div className="card" key={o.id}>
            <div className="row">
              <Link href={`/cabinet/objects/${o.id}`}>
                <strong>{o.address}</strong>
              </Link>
              <span className="tag">{STATE_RU[o.publication_state] ?? o.publication_state}</span>
              <span>{money(o.price, o.currency)}</span>
              <span className="key">{o.deal_type === 'sale' ? 'продажа' : 'аренда'}</span>
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              {o.zone ? <span className="key">{o.zone}</span> : null}
              {o.rooms ? <span>{o.rooms} комн.</span> : null}
              {o.area ? <span>{o.area} м²</span> : null}
              {o.floor ? <span className="key">этаж {o.floor}</span> : null}
              <span className="key">актуально на</span>
              <span>{day(o.actual_at)}</span>
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">собственник</span>
              {o.owners ? (
                <span>{o.owners}</span>
              ) : (
                <span className="hidden-contact">скрыт</span>
              )}
              <span className="key">ведёт</span>
              <span>
                {o.responsible_name ?? '—'}
                {o.responsible_org_name ? ` · ${o.responsible_org_name}` : ' · частный агент'}
              </span>
              <span className="key">подборов</span>
              <span>{o.matches_count}</span>
              <span className="key">комиссия</span>
              <span>{money(o.commission_total, o.currency)}</span>
            </div>

            {/* Состояние мандата важнее остального: без активного объект
                нельзя опубликовать. */}
            <div className="row" style={{ marginTop: 6 }}>
              {!o.active_mandate_id ? (
                <span className="warn">нет активного мандата — публикация невозможна</span>
              ) : (
                <>
                  <span className="key">мандат</span>
                  <span>{o.listing_agent_name ?? '—'}</span>
                  {o.contract_confirmed === false ? (
                    <span className="warn">договор требует подтверждения</span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ))
      )}

      <Pager base="/cabinet/objects" filters={f} total={count ?? 0} />
    </>
  );
}
