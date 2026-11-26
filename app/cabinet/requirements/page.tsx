import Link from 'next/link';
import { requirementList, type RequirementListItem } from '@/lib/db/cabinet';
import { PAGE_SIZE, parseFilters, money, day } from '@/lib/list-params';
import { Pager } from '../Pager';
import { SortTh } from '../SortTh';

export const metadata = { title: 'Потребности' };

const BASE = '/cabinet/requirements';


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
  // Чужие потребности видны — это нормально, подбор объекта чужому клиенту
  // полезен. Закрыто имя клиента: его открывает инвариант 4, и решает это
  // запрос, а не страница.
  let rows: RequirementListItem[] = [];
  let error: string | null = null;

  try {
    rows = await requirementList({
      status: f.status, deal: f.deal, zone: f.zone, q: f.q,
      sort: f.sort, dir: f.dir,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить потребности.';
  }

  const count = rows.length;

  return (
    <>
      <div className="head">
        <h1>Потребности</h1>
        <Link className="btn" href="/cabinet/requirements/new">Новая потребность</Link>
      </div>
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
          <Link href="/cabinet/requirements" className="key reset">сбросить</Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          {count === 0 && !f.deal && !f.status && !f.zone && !f.q
            ? 'Потребностей пока нет.'
            : 'Под эти условия ничего не подошло. Попробуйте ослабить фильтр.'}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <SortTh base={BASE} f={f} col="budget" label="Бюджет" className="num" />
                <SortTh base={BASE} f={f} col="deal" label="Сделка" />
                <SortTh base={BASE} f={f} col="status" label="Статус" />
                <th>Клиент</th>
                <SortTh base={BASE} f={f} col="agent" label="Ведёт" />
                <th>Что ищет</th>
                <SortTh base={BASE} f={f} col="matches" label="Подборов" className="num" />
                <SortTh base={BASE} f={f} col="showings" label="Показов" className="num" />
                <SortTh base={BASE} f={f} col="deadline" label="Срок" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num" data-l="Бюджет">
                    <Link className="tbl-main" href={`/cabinet/requirements/${r.id}`}>
                      {money(r.budget_min)} – {money(r.budget_max)}
                    </Link>
                  </td>
                  <td data-l="Сделка">{r.deal_type === 'sale' ? 'покупка' : 'аренда'}</td>
                  <td data-l="Статус">
                    <span className="tag">{STATUS_RU[r.status] ?? r.status}</span>
                    {r.deals_count > 0 ? (
                      <span className="tbl-note"><span className="tag">в сделке</span></span>
                    ) : null}
                  </td>
                  <td data-l="Клиент">
                    {r.client_name ?? <span className="hidden-contact">скрыт</span>}
                  </td>
                  <td data-l="Ведёт">{r.agent_name ?? '—'}</td>
                  <td data-l="Что ищет">
                    {[
                      r.zones?.length ? r.zones.join(', ') : null,
                      r.rooms?.length ? `${r.rooms.join(', ')} комн.` : null,
                    ].filter(Boolean).join(' · ') || '—'}
                    {r.requirements_text ? (
                      <span className="tbl-sub">{r.requirements_text}</span>
                    ) : null}
                  </td>
                  <td className="num" data-l="Подборов">{r.matches_count}</td>
                  <td className="num" data-l="Показов">{r.showings_count}</td>
                  <td className="nowrap" data-l="Срок">
                    {r.deadline ? day(r.deadline) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager base="/cabinet/requirements" filters={f} total={count ?? 0} />
    </>
  );
}
