import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  activityFeed, matchableObjects, requirementCard, requirementMatches,
} from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { Activities, type ActivityRow } from '../../Activities';
import type { RequirementMatch } from '@/lib/types';
import { CreateMatchForm } from '../../CreateMatchForm';
import { ContactCell } from '../../HiddenContact';
import { StartDealButton } from '../../deals/StartDealButton';
import { MatchStatus } from '../../MatchStatus';
import { TransferForm, type Colleague } from '../../TransferForm';
import { transferContact } from '../../transfer-actions';

const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

export default async function RequirementCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const requirement = await requirementCard(id);
  if (!requirement) notFound();

  const [matches, objects, colleagues, activities] = await Promise.all([
    requirementMatches(id),
    // Объекты того же направления: подбор аренды к покупке бессмыслен, и
    // слой доступа такой подбор всё равно отклонит.
    matchableObjects(requirement.deal_type),
    approvedColleagues(),
    activityFeed('requirement', id),
  ]);



  const rows = matches as unknown as RequirementMatch[];
  const alreadyMatched = new Set(rows.map((r) => r.object_id));

  const options = objects
    .filter((o) => !alreadyMatched.has(o.id))
    .map((o) => ({
      id: o.id,
      label: `${o.address} · ${money(o.price, o.currency)}${o.rooms ? ` · ${o.rooms} комн.` : ''}`,
    }));

  // Имя клиента отдаёт сам запрос карточки: null означает, что инвариант 4
  // его не открывает, и страница обязана показать это как «контакт скрыт»,
  // а не как пустое место.
  const clientName = requirement.client_name;

  return (
    <>
      <h1>
        Потребность: {requirement.deal_type === 'sale' ? 'покупка' : 'аренда'}
      </h1>
      <p className="sub">
        {money(requirement.budget_min)} – {money(requirement.budget_max)}
        {requirement.zones?.length ? ` · ${requirement.zones.join(', ')}` : ''}
        {requirement.rooms?.length ? ` · ${requirement.rooms.join(', ')} комн.` : ''}
      </p>

      <div className="card">
        <div className="row">
          <span className="key">Клиент</span>
          <ContactCell name={clientName} />
          <span className="key">Статус</span>
          <span className="tag">{requirement.status}</span>
          {requirement.deadline ? (
            <>
              <span className="key">Срок</span>
              <span>{new Date(requirement.deadline).toLocaleDateString('ru-RU')}</span>
            </>
          ) : null}
        </div>
        {requirement.requirements_text ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="key">Требования</span>
            <span>{requirement.requirements_text}</span>
          </div>
        ) : null}
      </div>

      <p className="key">
        <Link href={`/cabinet/requirements/${requirement.id}/edit`}>
          править потребность →
        </Link>
      </p>

      {/* Передаётся КЛИЕНТ целиком, а не одна потребность: иначе контакт
          остался бы у одного агента, а работа с ним — у другого. */}
      {clientName ? (
        <div style={{ marginTop: 12 }}>
          <TransferForm
            action={transferContact}
            idField="contact_id"
            idValue={requirement.contact_id}
            colleagues={(colleagues ?? []) as Colleague[]}
            what="клиента"
            warning="Клиент перейдёт коллеге целиком: контакт, все его открытые потребности и подборы по ним — вместе с долей closing-агента в комиссии. Телефон вы больше видеть не будете."
          />
        </div>
      ) : null}

      <h2>Подборы ({rows.length})</h2>

      {rows.length === 0 ? (
        <p className="empty">По этой потребности подборов пока нет.</p>
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
              <strong>{m.address}</strong>
              <span>{money(m.price, m.currency)}</span>
              {m.rooms ? <span>{m.rooms} комн.</span> : null}
              {m.zone ? <span className="key">{m.zone}</span> : null}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">собственник</span>
              <ContactCell name={m.owner_name} />
              <span className="key">listing-агент</span>
              <span>{m.listing_agent_name ?? '—'}</span>
              {m.contract_confirmed === false ? (
                <span className="warn">договор требует подтверждения</span>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">показ</span>
              <span>{when(m.showing_at)}</span>
              <span className="key">комиссия</span>
              <span>
                {money(m.commission_total)}
                {m.deal_status !== 'closed' ? ' (индикативно)' : ''}
              </span>
              <span className="key">актуально на</span>
              <span>{when(m.actual_at)}</span>
              {m.deal_id ? <span className="tag">сделка: {m.deal_status}</span> : null}
            </div>
            {m.rejection_reason ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="key">причина отказа</span>
                <span>{m.rejection_reason}</span>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 6 }}>
              <Link href={`/cabinet/objects/${m.object_id}`}>к объекту →</Link>
              {m.deal_id ? (
                <Link href={`/cabinet/deals/${m.deal_id}`}>к сделке →</Link>
              ) : m.match_status !== 'rejected' ? (
                <StartDealButton
                  matchId={m.match_id}
                  objectId={m.object_id}
                  requirementId={requirement.id}
                />
              ) : null}
            </div>
          </div>
        ))
      )}

      <Activities
        entityType="requirement"
        entityId={requirement.id}
        rows={(activities ?? []) as ActivityRow[]}
        colleagues={(colleagues ?? []) as Colleague[]}
      />

      <h2>Создать подбор</h2>
      <CreateMatchForm
        fixed="requirement"
        fixedValue={requirement.id}
        options={options}
        back={`/cabinet/requirements/${requirement.id}`}
        emptyHint="Нет опубликованных объектов с подходящим типом сделки, которые ещё не подобраны под эту потребность."
      />
    </>
  );
}
