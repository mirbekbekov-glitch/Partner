import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  activeMandateOf, activityFeed, objectCard, objectMatches, openRequirements,
} from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { canEditObject } from '@/lib/db/access';
import { Activities, type ActivityRow } from '../../Activities';
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

/** Зоны потребности лежат JSON-строкой: в базе нет типа массива. */
const zonesOf = (v: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(v ?? '[]');
    return Array.isArray(parsed) ? parsed as string[] : [];
  } catch {
    return [];
  }
};

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

export default async function ObjectCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [object, matches, requirements, mandate, canEdit, colleagues, activities] =
    await Promise.all([
      objectCard(id),
      objectMatches(id),
      // Открытые потребности для кнопки «создать подбор». Направление
      // сверяет слой доступа, но незачем показывать заведомо негодные.
      openRequirements(),
      activeMandateOf(id),
      // Право на правку считает предикат: про listing-агента активного
      // мандата и про админа в коде страницы судить нечем.
      canEditObject(id),
      approvedColleagues(),
      activityFeed('object', id),
    ]);

  if (!object) notFound();

  const rows = matches as unknown as ObjectMatch[];
  const alreadyMatched = new Set(rows.map((r) => r.requirement_id));

  const options = requirements
    .filter((r) => r.deal_type === object.deal_type && !alreadyMatched.has(r.id))
    .map((r) => ({
      id: r.id,
      label: `${money(r.budget_min, object.currency)} – ${money(r.budget_max, object.currency)}${
        zonesOf(r.zones).length ? ` · ${zonesOf(r.zones).join(', ')}` : ''
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

      <Activities
        entityType="object"
        entityId={object.id}
        rows={(activities ?? []) as ActivityRow[]}
      />

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
