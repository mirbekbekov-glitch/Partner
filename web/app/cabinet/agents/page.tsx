import type { Metadata } from "next";
import { agencyAgents } from "../../../lib/cabinet";
import { formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { approveAgent, blockAgent, setAgentRole } from "../actions";

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

  return (
    <div className="wrap">
      <h1>Агенты</h1>
      <p className="lead">
        {admin
          ? "Одобрение открывает кабинет: до него человек видит только себя. Разжаловать или заблокировать последнего администратора нельзя — иначе одобрять станет некому."
          : "Состав агентства. Одобрение и роли — дело администратора."}
      </p>

      {note && <p className="ok-banner">{note}</p>}

      <div className="rows">
        {agents.map((a) => (
          <article key={a.id} className={a.status === "pending" ? "row alarm" : "row"}>
            <div className="row-main">
              <h3>{a.full_name}</h3>
              <p className="row-meta">{formatPhone(a.phone)}</p>
              <p className="muted">
                {a.objects_total} объектов · {a.mandates_active} действующих договоров ·{" "}
                {a.deals_closed} закрытых сделок
              </p>
            </div>

            <div className="row-state">
              <span className={`chip ${a.status}`}>{STATUS[a.status] ?? a.status}</span>
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
