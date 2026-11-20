import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { ObjectMatch } from '@/lib/types';
import { CreateMatchForm } from '../../CreateMatchForm';
import { ContactCell } from '../../HiddenContact';
import { ObjectActions } from '../ObjectActions';
import { StartDealButton } from '../../deals/StartDealButton';
import { MatchStatus } from '../../MatchStatus';
import { TransferForm, type Colleague } from '../../TransferForm';
import { transferObject } from '../../transfer-actions';

const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

export default async function ObjectCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: object },
    { data: matches },
    { data: requirements },
    { data: mandate },
    { data: canEdit },
    { data: colleagues },
  ] = await Promise.all([
      supabase
        .from('objects')
        .select('id, kind, deal_type, address, zone, rooms, area, floor, price, currency, publication_state, published_at, actual_at')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('object_matches_v')
        .select('*')
        .eq('object_id', id)
        .order('created_at', { ascending: false }),
      // Открытые потребности для кнопки «создать подбор». Тип сделки сверяет
      // база, но незачем показывать заведомо негодные варианты.
      supabase
        .from('requirements')
        .select('id, deal_type, budget_min, budget_max, zones')
        .not('status', 'in', '("closed","lost")'),
      supabase
        .from('mandates')
        .select('id, kind, contract_confirmed, valid_to')
        .eq('object_id', id)
        .eq('status', 'active')
        .maybeSingle(),
      // Право на правку знает только база: про listing-агента активного
      // мандата и про админа в коде страницы судить нечем.
      supabase.rpc('can_edit_object', { p_object_id: id }),
      supabase.from('transfer_targets_v').select('id, full_name, role').order('full_name'),
    ]);

  if (!object) notFound();

  const rows = (matches ?? []) as ObjectMatch[];
  const alreadyMatched = new Set(rows.map((r) => r.requirement_id));

  const options = (requirements ?? [])
    .filter((r) => r.deal_type === object.deal_type && !alreadyMatched.has(r.id))
    .map((r) => ({
      id: r.id,
      label: `${money(r.budget_min, object.currency)} – ${money(r.budget_max, object.currency)}${
        r.zones?.length ? ` · ${r.zones.join(', ')}` : ''
      }`,
    }));

  return (
    <>
      <h1>{object.address}</h1>
      <p className="sub">
        {object.deal_type === 'sale' ? 'Продажа' : 'Аренда'} · {money(object.price, object.currency)}
        {object.zone ? ` · ${object.zone}` : ''}
        {object.rooms ? ` · ${object.rooms} комн.` : ''}
        {object.area ? ` · ${object.area} м²` : ''}
      </p>

      <div className="card">
        <div className="row">
          <span className="key">Публикация</span>
          <span className="tag">{object.publication_state}</span>
          <span className="key">Опубликован</span>
          <span>{when(object.published_at)}</span>
          <span className="key">Актуально на</span>
          <span>{when(object.actual_at)}</span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">Мандат</span>
          {mandate ? (
            <>
              <span className="tag">{mandate.kind === 'exclusive' ? 'эксклюзив' : 'неэксклюзив'}</span>
              {!mandate.contract_confirmed ? (
                <span className="warn">договор требует подтверждения</span>
              ) : null}
              {mandate.valid_to ? (
                <>
                  <span className="key">до</span>
                  <span>{new Date(mandate.valid_to).toLocaleDateString('ru-RU')}</span>
                </>
              ) : null}
            </>
          ) : (
            <span className="warn">активного мандата нет — объект нельзя опубликовать</span>
          )}
        </div>
      </div>

      <ObjectActions
        objectId={object.id}
        publicationState={object.publication_state}
        activeMandateId={mandate?.id ?? null}
        canEdit={canEdit === true}
      />

      {canEdit === true ? (
        <>
          <p className="key" style={{ marginTop: 8 }}>
            <Link href={`/cabinet/objects/${object.id}/edit`}>править объект →</Link>
          </p>
          <div style={{ marginTop: 12 }}>
            <TransferForm
              action={transferObject}
              idField="object_id"
              idValue={object.id}
              colleagues={(colleagues ?? []) as Colleague[]}
              what="объект"
              warning="Объект и активный мандат перейдут коллеге — вместе с долей listing-агента в комиссии. Править его вы больше не сможете."
            />
          </div>
        </>
      ) : null}

      <h2>Подборы ({rows.length})</h2>

      {rows.length === 0 ? (
        <p className="empty">По этому объекту подборов пока нет.</p>
      ) : (
        rows.map((m) => (
          <div className="card" key={m.match_id}>
            <div className="row">
              <MatchStatus
                matchId={m.match_id}
                status={m.match_status}
                showingAt={m.showing_at}
                rejectionReason={m.rejection_reason}
                canLead={m.can_lead}
                hasDeal={Boolean(m.deal_id)}
              />
              <ContactCell name={m.client_name} />
              <span className="key">бюджет</span>
              <span>
                {money(m.budget_min)} – {money(m.budget_max)}
              </span>
              {m.rooms_wanted?.length ? (
                <>
                  <span className="key">комнат</span>
                  <span>{m.rooms_wanted.join(', ')}</span>
                </>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">ведёт</span>
              <span>{m.closing_agent_name ?? '—'}</span>
              <span className="key">показ</span>
              <span>{when(m.showing_at)}</span>
              <span className="key">комиссия</span>
              <span>
                {money(m.commission_total)}
                {m.deal_status !== 'closed' ? ' (индикативно)' : ''}
              </span>
              {m.deal_id ? (
                <span className="tag">сделка: {m.deal_status}</span>
              ) : null}
            </div>
            {m.rejection_reason ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="key">причина отказа</span>
                <span>{m.rejection_reason}</span>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 6 }}>
              <Link href={`/cabinet/requirements/${m.requirement_id}`}>к потребности →</Link>
              {m.deal_id ? (
                <Link href={`/cabinet/deals/${m.deal_id}`}>к сделке →</Link>
              ) : m.match_status !== 'rejected' ? (
                <StartDealButton
                  matchId={m.match_id}
                  objectId={object.id}
                  requirementId={m.requirement_id}
                />
              ) : null}
            </div>
          </div>
        ))
      )}

      <h2>Создать подбор</h2>
      <CreateMatchForm
        fixed="object"
        fixedValue={object.id}
        options={options}
        back={`/cabinet/objects/${object.id}`}
        emptyHint="Нет открытых потребностей с подходящим типом сделки, под которые этот объект ещё не подобран."
      />
    </>
  );
}
