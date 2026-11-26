import Link from 'next/link';
import { objectList, type ObjectListItem } from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { currentAgent } from '@/lib/db/session';
import { PAGE_SIZE, parseFilters, money, day } from '@/lib/list-params';
import { Pager } from '../Pager';
import { SortTh } from '../SortTh';

export const metadata = { title: 'Объекты' };

const BASE = '/cabinet/objects';


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

  let rows: ObjectListItem[] = [];
  let total = 0;
  let error: string | null = null;

  try {
    ({ rows, total } = await objectList({
      state: f.state, deal: f.deal, zone: f.zone, q: f.q,
      source, agentId, sort: f.sort, dir: f.dir, page: f.page,
    }));
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить объекты.';
  }

  const count = total;

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
        {/* Сортировка переживает фильтрацию: форма отправляется методом
            get, и всё, чего в ней нет, из адреса пропадает. */}
        {f.sort ? (
          <>
            <input type="hidden" name="sort" value={f.sort} />
            <input type="hidden" name="dir" value={f.dir} />
          </>
        ) : null}
        <button type="submit">Фильтр</button>
        {f.deal || f.state || f.zone || f.q || f.src ? (
          <Link href="/cabinet/objects" className="key reset">сбросить</Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          {total === 0 && !f.deal && !f.state && !f.zone && !f.q
            ? 'Объектов пока нет.'
            : 'Под эти условия ничего не подошло. Попробуйте ослабить фильтр.'}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <SortTh base={BASE} f={f} col="address" label="Адрес" />
                <SortTh base={BASE} f={f} col="deal" label="Сделка" />
                <SortTh base={BASE} f={f} col="state" label="Состояние" />
                <SortTh base={BASE} f={f} col="price" label="Цена" className="num" />
                <th className="num">Комиссия</th>
                <SortTh base={BASE} f={f} col="matches" label="Подборов" className="num" />
                <th>Собственник</th>
                <SortTh base={BASE} f={f} col="agent" label="Ведёт" />
                <SortTh base={BASE} f={f} col="actual" label="Актуально" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="tbl-main" href={`/cabinet/objects/${o.id}`}>
                      {o.address}
                    </Link>
                    <span className="tbl-sub">
                      {[
                        o.zone,
                        o.rooms ? `${o.rooms} комн.` : null,
                        o.area ? `${o.area} м²` : null,
                        o.floor ? `этаж ${o.floor}` : null,
                      ].filter(Boolean).join(' · ') || 'без характеристик'}
                    </span>
                  </td>
                  <td data-l="Сделка">{o.deal_type === 'sale' ? 'продажа' : 'аренда'}</td>
                  <td data-l="Состояние">
                    <span className="tag">
                      {STATE_RU[o.publication_state] ?? o.publication_state}
                    </span>
                    {/* Состояние мандата важнее остального: без активного
                        объект нельзя опубликовать. */}
                    {!o.mandate_id ? (
                      <span className="tbl-note">
                        <span className="warn">нет активного мандата</span>
                      </span>
                    ) : o.contract_confirmed === false ? (
                      <span className="tbl-note">
                        <span className="warn">договор требует подтверждения</span>
                      </span>
                    ) : null}
                  </td>
                  <td className="num" data-l="Цена">{money(o.price, o.currency)}</td>
                  <td className="num" data-l="Комиссия">
                    {money(o.commission_total, o.currency)}
                  </td>
                  <td className="num" data-l="Подборов">{o.matches_count}</td>
                  <td data-l="Собственник">
                    {o.owner_name ?? <span className="hidden-contact">скрыт</span>}
                  </td>
                  <td data-l="Ведёт">
                    {o.responsible_name ?? '—'}
                    <span className="tbl-sub">
                      {o.responsible_org_name ?? 'частный агент'}
                    </span>
                  </td>
                  <td className="nowrap" data-l="Актуально">{day(o.actual_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager base={BASE} filters={f} total={total} />
    </>
  );
}
