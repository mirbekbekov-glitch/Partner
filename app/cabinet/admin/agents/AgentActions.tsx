'use client';

import { useActionState } from 'react';
import { approveAgent, blockAgent, setAgentRole, confirmAgentOrg } from './actions';

type Result = { error: string | null };
type Action = (fd: FormData) => Promise<Result>;

function Button({
  action,
  agentId,
  label,
  role,
  confirmed,
  confirmText,
}: {
  action: Action;
  agentId: string;
  label: string;
  role?: 'agent' | 'admin';
  confirmed?: boolean;
  confirmText?: string;
}) {
  const [state, formAction, pending] = useActionState<Result, FormData>(
    async (_prev, fd) => action(fd),
    { error: null },
  );

  return (
    <>
      <form
        action={formAction}
        style={{ display: 'inline' }}
        onSubmit={(e) => {
          // Блокировка и разжалование — шаги, которые человек может сделать
          // по ошибке и не сразу заметить, поэтому спрашиваем.
          if (confirmText && !window.confirm(confirmText)) e.preventDefault();
        }}
      >
        <input type="hidden" name="agent_id" value={agentId} />
        {role ? <input type="hidden" name="role" value={role} /> : null}
        {confirmed !== undefined
          ? <input type="hidden" name="confirmed" value={String(confirmed)} />
          : null}
        <button type="submit" disabled={pending} className="ghost">
          {pending ? '…' : label}
        </button>
      </form>
      {state.error ? <span className="error inline-error">{state.error}</span> : null}
    </>
  );
}

export function AgentActions({
  agentId,
  status,
  role,
  hasOrg,
  orgConfirmed,
}: {
  agentId: string;
  status: string;
  role: string;
  hasOrg: boolean;
  orgConfirmed: boolean;
}) {
  return (
    <div className="actions">
      {hasOrg && !orgConfirmed ? (
        <Button action={confirmAgentOrg} agentId={agentId} confirmed
                label="Подтвердить агентство" />
      ) : null}
      {hasOrg && orgConfirmed ? (
        <Button action={confirmAgentOrg} agentId={agentId} confirmed={false}
                label="Снять подтверждение"
                confirmText="Снять подтверждение принадлежности к агентству?" />
      ) : null}
      {status !== 'approved' ? (
        <Button action={approveAgent} agentId={agentId} label="Одобрить" />
      ) : null}

      {status === 'approved' ? (
        <Button
          action={blockAgent}
          agentId={agentId}
          label="Заблокировать"
          confirmText="Заблокировать агента? Он потеряет доступ к CRM, но останется владельцем своих контактов и объектов."
        />
      ) : null}

      {role === 'agent' ? (
        <Button action={setAgentRole} agentId={agentId} label="Сделать админом" role="admin" />
      ) : (
        <Button
          action={setAgentRole}
          agentId={agentId}
          label="Снять админа"
          role="agent"
          confirmText="Снять права администратора?"
        />
      )}
    </div>
  );
}
