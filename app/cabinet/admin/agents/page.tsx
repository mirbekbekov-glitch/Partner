import { listAgents } from '@/lib/db/agents';

type Row = Awaited<ReturnType<typeof listAgents>>[number];
import { AgentActions } from './AgentActions';

export const metadata = { title: 'Агенты' };

const STATUS_RU: Record<string, string> = {
  pending: 'ждёт одобрения',
  approved: 'одобрен',
  blocked: 'заблокирован',
};

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleDateString('ru-RU', { dateStyle: 'medium' });


export default async function AgentsAdminPage() {
  // Проверка «только админ» — первая строка listAgents(). Раньше её делало
  // представление с «where app.is_admin()» внутри, и не админу оно просто
  // ничего не отдавало; теперь такой подстраховки нет, и отказ приходит
  // исключением.
  let rows: Row[] = [];
  let error: string | null = null;

  try {
    rows = await listAgents();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Список недоступен.';
  }

  if (error) {
    return (
      <>
        <h1>Агенты</h1>
        <p className="error">{error}</p>
      </>
    );
  }

  const pending = rows.filter((r) => r.status === 'pending');
  const rest = rows.filter((r) => r.status !== 'pending');

  if (rows.length === 0) {
    return (
      <>
        <h1>Агенты</h1>
        <p className="empty">
          Список пуст. Если вы вошли не администратором, этот экран ничего не покажет.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Агенты</h1>
      <p className="sub">
        Одобрение открывает доступ к CRM. Заблокированный агент теряет доступ, но
        остаётся владельцем своих контактов и объектов — ничего не теряется.
      </p>

      <h2>Ждут одобрения ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="empty">Новых заявок нет.</p>
      ) : (
        pending.map((a) => <AgentCard key={a.id} a={a} />)
      )}

      <h2>Остальные ({rest.length})</h2>
      {rest.map((a) => <AgentCard key={a.id} a={a} />)}
    </>
  );
}

function AgentCard({ a }: { a: Row }) {
  return (
    <div className="card">
      <div className="row">
        <strong>{a.full_name}</strong>
        <span className="tag">{STATUS_RU[a.status] ?? a.status}</span>
        {a.role === 'admin' ? <span className="tag">админ</span> : null}
        {/* Агентство заявляет сам агент, поэтому неподтверждённое помечаем
            прямо здесь: иначе «Этажи» в списке читаются как проверенный факт. */}
        {a.organization_name ? (
          <span className={a.org_confirmed ? 'tag' : 'warn'}>
            {a.organization_name}{a.org_confirmed ? '' : ' — не подтверждено'}
          </span>
        ) : (
          <span className="key">частный агент</span>
        )}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="key">почта</span>
        <span>{a.email ?? '—'}</span>
        <span className="key">телефон</span>
        <span>{a.phone ?? '—'}</span>
        {a.telegram_id ? (
          <>
            <span className="key">telegram</span>
            <span>{a.telegram_id}</span>
          </>
        ) : null}
        <span className="key">заведён</span>
        <span>{when(a.created_at)}</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="key">наработано</span>
        <span>
          объектов {a.objects_count} · контактов {a.contacts_count} · потребностей{' '}
          {a.requirements_count}
        </span>
      </div>
      <AgentActions
        agentId={a.id}
        status={a.status}
        role={a.role}
        hasOrg={a.organization_name !== null}
        orgConfirmed={a.org_confirmed === 1}
        certificateNo={a.certificate_no}
        certificateConfirmed={a.certificate_confirmed === 1}
      />
    </div>
  );
}
