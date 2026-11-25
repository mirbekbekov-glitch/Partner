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
        open.map((d) => <DealRow key={d.id} d={d} />)
      )}

      {done.length > 0 ? (
        <>
          <h2>Завершённые ({done.length})</h2>
          {done.map((d) => <DealRow key={d.id} d={d} />)}
        </>
      ) : null}
    </>
  );
}

function DealRow({ d }: { d: Row }) {
  return (
    <div className="card">
      <div className="row">
        <Link href={`/cabinet/deals/${d.id}`}>
          <strong>{d.address}</strong>
        </Link>
        <span className="tag">{DEAL_STATUS_RU[d.status] ?? d.status}</span>
        <span className="key">{d.deal_type === 'sale' ? 'продажа' : 'аренда'}</span>
        {!d.can_act ? <span className="key">вы не участник</span> : null}
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <span className="key">клиент</span>
        {d.client_name ? <span>{d.client_name}</span> : <span className="hidden-contact">скрыт</span>}
        <span className="key">listing</span>
        <span>{d.listing_agent_name ?? '—'}</span>
        <span className="key">closing</span>
        <span>{d.closing_agent_name ?? '—'}</span>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <span className="key">{d.status === 'closed' ? 'финальная цена' : 'цена объекта'}</span>
        <span>{money(d.final_price ?? d.object_price, d.currency)}</span>
        <span className="key">комиссия</span>
        <span>
          {money(d.commission_total, d.currency)}
          {d.is_indicative ? ' (индикативно)' : ''}
        </span>
        <span className="key">доли</span>
        <span>
          {money(d.listing_share, d.currency)} / {money(d.closing_share, d.currency)}
        </span>
      </div>

      {d.failure_reason ? (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="key">причина срыва</span>
          <span>{d.failure_reason}</span>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 6 }}>
        <span className="key">начата</span>
        <span>{day(d.created_at)}</span>
        {d.closed_at ? (
          <>
            <span className="key">завершена</span>
            <span>{day(d.closed_at)}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
