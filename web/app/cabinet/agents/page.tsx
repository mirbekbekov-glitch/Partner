import type { Metadata } from "next";
import { agencyAgents, certificateQueue } from "../../../lib/cabinet";
import { formatDate, formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import {
  approveAgent,
  blockAgent,
  confirmCertificate,
  revokeCertificate,
  setAgentRole,
} from "../actions";

export const metadata: Metadata = {
  title: "Агенты",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, string> = {
  pending: "ждёт одобрения",
  approved: "работает",
  blocked: "заблокирован",
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;

  const agents = await agencyAgents();
  const admin = access.agent.is_admin;
  // Очередь сверки аттестаций. Представление само отдаёт только то, что
  // видно политикой, поэтому спрашивать его не только администратору можно:
  // агент увидит в нём себя и коллег своего агентства.
  const claims = await certificateQueue();

  return (
    <div className="wrap">
      <h1>Агенты</h1>
      <p className="lead">
        {admin
          ? "Одобрение открывает кабинет: до него человек видит только себя. Разжаловать или заблокировать последнего администратора нельзя — иначе одобрять станет некому."
          : "Состав агентства. Одобрение и роли — дело администратора."}
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {/* Тариф назван здесь, а не только в отказе базы: человек приходит на
          этот экран именно затем, чтобы работать не одному. */}
      {access.agent.agency_plan === "solo" && (
        <p className="warn-banner">
          Тариф агентства — бесплатный: в нём один агент. Объекты и клиенты
          при этом не ограничены. Второй человек и выгрузка на чужие площадки
          — на тарифе «команда».
        </p>
      )}

      {claims.length > 0 && (
        <section>
          <h2>Аттестация ТПП <span className="muted">({claims.length})</span></h2>
          <p className="muted">
            {admin
              ? "Номер со слов агента. Сверьте его с палатой и подтвердите — до этого коллеги видят «заявлен», а не «в реестре». Онлайн-реестра, который можно спросить запросом, у ТПП пока нет, поэтому сверка ручная."
              : "Номер со слов агента. Подтверждает его администратор платформы, сверив с палатой."}
          </p>
          <div className="rows">
            {claims.map((c) => (
              <article key={c.agent_id}
                       className={c.state === "заявлен" ? "row alarm" : "row"}>
                <div className="row-main">
                  <h3>{c.full_name}</h3>
                  <p className="row-meta">
                    {c.agency_name} · № {c.certificate_no}
                    {c.certificate_issued_on && ` · выдан ${formatDate(c.certificate_issued_on)}`}
                    {c.certificate_valid_to && ` · до ${formatDate(c.certificate_valid_to)}`}
                  </p>
                  {c.confirmed_by_name && (
                    <p className="faint sm">сверил {c.confirmed_by_name}</p>
                  )}
                </div>
                <div className="row-state">
                  <span className={
                    c.state === "подтверждён" ? "chip ok"
                      : c.state === "истёк" ? "chip danger" : "chip warn"
                  }>{c.state}</span>
                </div>
                {admin && (
                  <div className="row-acts">
                    {c.state !== "подтверждён" && (
                      <ActionForm action={confirmCertificate} label="Сверено, подтвердить">
                        <input type="hidden" name="agent_id" value={c.agent_id} />
                      </ActionForm>
                    )}
                    {c.certificate_confirmed_at && (
                      <details className="fold">
                        <summary>Снять</summary>
                        <ActionForm action={revokeCertificate} label="Снять" danger>
                          <input type="hidden" name="agent_id" value={c.agent_id} />
                          <label>
                            Почему
                            <input name="reason" maxLength={120}
                                   placeholder="в палате такого номера нет" />
                          </label>
                        </ActionForm>
                      </details>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <h2>Состав</h2>
      <div className="rows">
        {agents.map((a) => (
          <article key={a.id} className={a.status === "pending" ? "row alarm" : "row"}>
            <div className="row-main">
              <h3 className="avatar-name">
                {a.avatar_key ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img className="avatar" src={`/avatar/${a.avatar_key}`}
                       alt="" width={32} height={32} />
                ) : (
                  <span className="avatar empty" aria-hidden="true">
                    {a.full_name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                {a.full_name}
              </h3>
              <p className="row-meta">{formatPhone(a.phone)}</p>
              <p className="muted">
                {a.objects_total} объектов · {a.mandates_active} действующих договоров ·{" "}
                {a.deals_closed} закрытых сделок
              </p>
            </div>

            <div className="row-state">
              <span className={`chip ${a.status}`}>{STATUS[a.status] ?? a.status}</span>
              {/* Аттестация рядом со статусом: «работает» и «в реестре» —
                  разные вещи, и первое второго не означает. */}
              {a.certificate_state === "подтверждён" ? (
                <span className="chip ok">в реестре ТПП</span>
              ) : a.certificate_state === "заявлен" ? (
                <span className="chip warn">аттестация заявлена</span>
              ) : a.certificate_state === "истёк" ? (
                <span className="chip danger">аттестация истекла</span>
              ) : null}
              {a.role === "admin" && <span className="chip admin">администратор</span>}
            </div>

            {admin && (
              <div className="row-acts">
                {a.status !== "approved" && (
                  <ActionForm action={approveAgent} label="Одобрить">
                    <input type="hidden" name="agent_id" value={a.id} />
                  </ActionForm>
                )}
                {a.status === "approved" && a.id !== access.agent.id && (
                  <ActionForm
                    action={blockAgent}
                    label="Заблокировать"
                    danger
                    confirm={`Заблокировать ${a.full_name}? Кабинет закроется сразу.`}
                  >
                    <input type="hidden" name="agent_id" value={a.id} />
                  </ActionForm>
                )}
                <ActionForm
                  action={setAgentRole}
                  label={a.role === "admin" ? "Сделать агентом" : "Сделать админом"}
                  confirm={
                    a.role === "admin"
                      ? `Снять с ${a.full_name} права администратора?`
                      : `Дать ${a.full_name} права администратора? Он увидит все телефоны собственников.`
                  }
                >
                  <input type="hidden" name="agent_id" value={a.id} />
                  <input type="hidden" name="role" value={a.role === "admin" ? "agent" : "admin"} />
                </ActionForm>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
