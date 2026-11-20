import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { MATCH_STATUS_RU, type RequirementMatch } from '@/lib/types';
import { CreateMatchForm } from '../../CreateMatchForm';
import { ContactCell } from '../../HiddenContact';

const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

export default async function RequirementCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: requirement }, { data: matches }, { data: objects }, { data: contact }] =
    await Promise.all([
      supabase
        .from('requirements')
        .select('id, contact_id, deal_type, budget_min, budget_max, zones, rooms, deadline, requirements_text, status')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('requirement_matches_v')
        .select('*')
        .eq('requirement_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('objects')
        .select('id, deal_type, address, zone, rooms, price, currency, publication_state')
        .eq('publication_state', 'published'),
      // Контакт клиента: вернёт null, если инвариант 4 его не отдаёт.
      supabase.from('requirements').select('contact_id, contacts(name)').eq('id', id).maybeSingle(),
    ]);

  if (!requirement) notFound();

  const rows = (matches ?? []) as RequirementMatch[];
  const alreadyMatched = new Set(rows.map((r) => r.object_id));

  const options = (objects ?? [])
    .filter((o) => o.deal_type === requirement.deal_type && !alreadyMatched.has(o.id))
    .map((o) => ({
      id: o.id,
      label: `${o.address} · ${money(o.price, o.currency)}${o.rooms ? ` · ${o.rooms} комн.` : ''}`,
    }));

  const clientName =
    (contact as { contacts?: { name: string } | null } | null)?.contacts?.name ?? null;

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

      <h2>Подборы ({rows.length})</h2>

      {rows.length === 0 ? (
        <p className="empty">По этой потребности подборов пока нет.</p>
      ) : (
        rows.map((m) => (
          <div className="card" key={m.match_id}>
            <div className="row">
              <span className="tag">{MATCH_STATUS_RU[m.match_status]}</span>
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
            </div>
          </div>
        ))
      )}

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
