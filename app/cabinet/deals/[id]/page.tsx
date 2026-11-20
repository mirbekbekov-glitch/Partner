import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Activities, type ActivityRow } from '../../Activities';
import { money, day } from '@/lib/list-params';
import { DealActions } from '../DealActions';
import { DEAL_STATUS_RU } from '../page';

export const metadata = { title: 'Сделка' };

export default async function DealCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: deal }, { data: activities }] = await Promise.all([
    supabase.from('deal_list_v').select('*').eq('id', id).maybeSingle(),
    supabase.from('activity_feed_v').select('*')
      .eq('entity_type', 'deal').eq('entity_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (!deal) notFound();

  const d = deal as {
    id: string; status: string; created_at: string; closed_at: string | null;
    final_price: number | null; failure_reason: string | null;
    object_id: string; requirement_id: string; match_id: string; mandate_id: string;
    address: string; deal_type: string; zone: string | null; rooms: number | null;
    object_price: number; currency: string;
    listing_agent_name: string | null; closing_agent_name: string | null;
    commission_total: number | null; listing_share: number | null;
    closing_share: number | null; is_indicative: boolean;
    client_name: string | null; owners: string | null; can_act: boolean;
  };

  return (
    <>
      <h1>{d.address}</h1>
      <p className="sub">
        Сделка · {DEAL_STATUS_RU[d.status] ?? d.status} ·{' '}
        {d.deal_type === 'sale' ? 'продажа' : 'аренда'}
        {d.zone ? ` · ${d.zone}` : ''}
      </p>

      <div className="card">
        <div className="row">
          <span className="key">клиент</span>
          {d.client_name ? (
            <strong>{d.client_name}</strong>
          ) : (
            <span className="hidden-contact">контакт скрыт</span>
          )}
          <span className="key">собственник</span>
          {d.owners ? (
            <strong>{d.owners}</strong>
          ) : (
            <span className="hidden-contact">контакт скрыт</span>
          )}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">listing-агент</span>
          <span>{d.listing_agent_name ?? '—'}</span>
          <span className="key">closing-агент</span>
          <span>{d.closing_agent_name ?? '—'}</span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">начата</span>
          <span>{day(d.created_at)}</span>
          {d.closed_at ? (
            <>
              <span className="key">завершена</span>
              <span>{day(d.closed_at)}</span>
            </>
          ) : null}
        </div>
        {d.failure_reason ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="warn">сорвана</span>
            <span>{d.failure_reason}</span>
          </div>
        ) : null}
      </div>

      <h2>Комиссия</h2>
      <div className="card">
        <div className="row">
          <span className="key">
            {d.status === 'closed' ? 'финальная цена' : 'текущая цена объекта'}
          </span>
          <strong>{money(d.final_price ?? d.object_price, d.currency)}</strong>
          <span className="key">итого</span>
          <strong>{money(d.commission_total, d.currency)}</strong>
          {d.is_indicative ? <span className="warn">индикативно</span> : null}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">listing 50%</span>
          <span>{money(d.listing_share, d.currency)}</span>
          <span className="key">closing 50%</span>
          <span>{money(d.closing_share, d.currency)}</span>
        </div>
        {d.is_indicative ? (
          <p className="key" style={{ marginTop: 8 }}>
            Суммы считаются от текущей цены объекта и изменятся, если цена изменится.
            Окончательные значения фиксируются при закрытии сделки.
          </p>
        ) : null}
      </div>

      <h2>Откуда</h2>
      <div className="card">
        <div className="row">
          <Link href={`/cabinet/objects/${d.object_id}`}>объект →</Link>
          <Link href={`/cabinet/requirements/${d.requirement_id}`}>потребность →</Link>
        </div>
      </div>

      <Activities entityType="deal" entityId={d.id} rows={(activities ?? []) as ActivityRow[]} />

      {d.can_act ? (
        <DealActions
          dealId={d.id}
          status={d.status}
          objectPrice={d.object_price}
          currency={d.currency}
        />
      ) : (
        <p className="key">
          Вы не сторона этой сделки: условия и комиссия видны, действия доступны
          listing-агенту, closing-агенту и администратору.
        </p>
      )}
    </>
  );
}
