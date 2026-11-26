import Link from 'next/link';
import { dealList } from '@/lib/db/cabinet';
import { money, day } from '@/lib/list-params';

export const metadata = { title: 'Сделки' };

export const DEAL_STATUS_RU: Record<string, string> = {
  deposit: 'аванс',
  documents: 'документы',
  signing: 'подписание',
  settlement: 'расчёт',
  closed: 'закрыта',
  failed: 'сорвана',
};

type Row = {
  id: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  final_price: number | null;
  failure_reason: string | null;
  object_id: string;
  address: string;
  deal_type: string;
  object_price: number;
  currency: string;
  listing_agent_name: string | null;
  closing_agent_name: string | null;
  commission_total: number | null;
  listing_share: number | null;
  closing_share: number | null;
  is_indicative: boolean;
  client_name: string | null;
  can_act: boolean;
};

export default async function DealsList() {
  // Сделку видят только её стороны: предикат стоит в запросе. Суммы до
  // закрытия индикативны и считаются на лету, после закрытия отдаются
  // зафиксированные — записывать индикативные нельзя, записанные означали
  // бы, что деньги уже поделены.
  let rows: Row[] = [];
  let error: string | null = null;

  try {
    rows = await dealList() as unknown as Row[];
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить сделки.';
  }
  const open = rows.filter((r) => r.status !== 'closed' && r.status !== 'failed');
  const done = rows.filter((r) => r.status === 'closed' || r.status === 'failed');

  return (
    <>
      <h1>Сделки</h1>
      <p className="sub">
        Сделка создаётся только из подбора. Суммы до закрытия индикативны и считаются
        от текущей цены объекта.
      </p>

      <h2>В работе ({open.length})</h2>
      {open.length === 0 ? (
        <p className="empty">
          Открытых сделок нет. Сделка начинается с подбора — на карточке объекта или
          потребности.
        </p>
      ) : (
        <DealTable rows={open} />
      )}

      {done.length > 0 ? (
        <>
          <h2>Завершённые ({done.length})</h2>
          <DealTable rows={done} />
        </>
      ) : null}
    </>
  );
}

/**
 * Таблица сделок.
 *
 * Колонок много, и это намеренно: сделку читают по деньгам — цена,
 * комиссия, доли сторон, — а их сравнивают между строками. На узком экране
 * таблица разбирается на карточки силами cabinet.css.
 */
function DealTable({ rows }: { rows: Row[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Объект</th>
            <th>Статус</th>
            <th>Клиент</th>
            <th>Listing</th>
            <th>Closing</th>
            <th className="num">Цена</th>
            <th className="num">Комиссия</th>
            <th className="num">Доли</th>
            <th>Начата</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <Link className="tbl-main" href={`/cabinet/deals/${d.id}`}>
                  {d.address}
                </Link>
                <span className="tbl-sub">
                  {d.deal_type === 'sale' ? 'продажа' : 'аренда'}
                  {!d.can_act ? ' · вы не участник' : ''}
                </span>
              </td>
              <td data-l="Статус">
                <span className="tag">{DEAL_STATUS_RU[d.status] ?? d.status}</span>
                {d.failure_reason ? (
                  <span className="tbl-sub">{d.failure_reason}</span>
                ) : null}
              </td>
              <td data-l="Клиент">
                {d.client_name ?? <span className="hidden-contact">скрыт</span>}
              </td>
              <td data-l="Listing">{d.listing_agent_name ?? '—'}</td>
              <td data-l="Closing">{d.closing_agent_name ?? '—'}</td>
              <td className="num" data-l={d.status === 'closed' ? 'Финальная цена' : 'Цена объекта'}>
                {money(d.final_price ?? d.object_price, d.currency)}
              </td>
              <td className="num" data-l="Комиссия">
                {money(d.commission_total, d.currency)}
                {d.is_indicative ? <span className="tbl-sub">индикативно</span> : null}
              </td>
              <td className="num" data-l="Доли">
                {money(d.listing_share, d.currency)}
                <span className="tbl-sub">/ {money(d.closing_share, d.currency)}</span>
              </td>
              <td className="nowrap" data-l="Начата">
                {day(d.created_at)}
                {d.closed_at ? (
                  <span className="tbl-sub">завершена {day(d.closed_at)}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
