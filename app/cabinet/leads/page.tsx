import Link from 'next/link';
import { leadFeed, type LeadFeedItem } from '@/lib/db/cabinet';
import { day, parseFilters } from '@/lib/list-params';
import { Pager } from '../Pager';
import { LeadActions } from './LeadActions';

export const metadata = { title: 'Заявки' };

const BASE = '/cabinet/leads';


const STATUS_RU: Record<string, string> = {
  new: 'новая',
  in_work: 'в работе',
  done: 'отработана',
  spam: 'спам',
};

export default async function Leads({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = raw && raw in STATUS_RU ? raw : null;
  // Разбор общий: постраничные ссылки собираются там же, где у остальных
  // списков. Статус заявки разбирается отдельно — набор значений свой.
  const f = parseFilters(sp);

  // Видимость стоит в самом запросе: заявки по объектам, за которые
  // отвечает этот агент. Раньше её обеспечивала политика базы, и условия
  // здесь не было вовсе — теперь страховки нет, поэтому предикат общий и
  // живёт в lib/db/visibility.ts.
  let rows: LeadFeedItem[] = [];
  let total = 0;
  let error: string | null = null;

  try {
    ({ rows, total } = await leadFeed(status, f.page));
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить заявки.';
  }

  return (
    <>
      <h1>Заявки</h1>
      <p className="sub">
        Заявки с сайта по объектам, которые ведёте вы. Телефон заявителя виден
        только вам и администратору.
      </p>

      <form className="filters" method="get">
        <label className="fld">
          <span>Статус</span>
          <select name="status" defaultValue={status ?? ''}>
            <option value="">любой</option>
            {Object.entries(STATUS_RU).map(([k, ru]) => (
              <option key={k} value={k}>{ru}</option>
            ))}
          </select>
        </label>
        <button type="submit">Фильтр</button>
        {status ? (
          <Link href="/cabinet/leads" className="key reset">сбросить</Link>
        ) : null}
      </form>

      {error ? <p className="error">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">
          {status ? 'С таким статусом заявок нет.' : 'Заявок пока нет.'}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Заявитель</th>
                <th>Объект</th>
                <th>Сообщение</th>
                <th>Статус</th>
                <th>Когда</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="tbl-main">{l.name}</span>
                    {/* Телефон — то, ради чего заявка существует: показываем
                        целиком и сразу, без «показать номер». Сюда дошли
                        только те, кому он положен: остальным политика не
                        отдала бы и строки. */}
                    <span className="tbl-sub">
                      <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`}>{l.phone}</a>
                    </span>
                  </td>
                  <td data-l="Объект">
                    <Link href={`/cabinet/objects/${l.object_id}`}>
                      {l.address ?? 'объект удалён'}
                    </Link>
                    {l.agent_name ? (
                      <span className="tbl-sub">ведёт {l.agent_name}</span>
                    ) : null}
                  </td>
                  <td data-l="Сообщение">
                    {l.message ? <span className="tbl-text">{l.message}</span> : '—'}
                  </td>
                  <td data-l="Статус">
                    <span className="tag">{STATUS_RU[l.status]}</span>
                  </td>
                  <td className="nowrap" data-l="Когда">{day(l.created_at)}</td>
                  <td data-l="Действия">
                    <LeadActions leadId={l.id} status={l.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Статус заявки подставляется в ссылки страниц отдельно: разбор
          фильтров проверяет status по набору значений потребности, и
          «в работе» или «спам» он бы отбросил. */}
      <Pager base={BASE} filters={{ ...f, status }} total={total} />
    </>
  );
}
