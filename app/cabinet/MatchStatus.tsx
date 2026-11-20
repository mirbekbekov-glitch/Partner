'use client';

import { useActionState, useState } from 'react';
import { setMatchStatus, type MatchResult } from './match-actions';

export const MATCH_STATUS_RU: Record<string, string> = {
  proposed: 'предложен',
  interested: 'интересно',
  showing_scheduled: 'показ назначен',
  showing_done: 'показ состоялся',
  bargaining: 'торг',
  rejected: 'отказ',
  in_deal: 'в сделке',
};

// «В сделке» в выборе нет: он ставится созданием сделки из подбора
// (инвариант 2), и база такую правку вручную отклоняет.
const CHOICES = ['proposed', 'interested', 'showing_scheduled', 'showing_done',
                 'bargaining', 'rejected'] as const;

/**
 * Ведение подбора по статусам.
 *
 * Отказ требует причины, показ — даты. Поля появляются по выбору статуса, а
 * не висят всегда: иначе форма просит то, что в большинстве случаев не нужно.
 * Проверяет всё равно база — здесь это только подсказка, что заполнить.
 */
export function MatchStatus({
  matchId,
  status,
  showingAt,
  rejectionReason,
  canLead,
  hasDeal,
}: {
  matchId: string;
  status: string;
  showingAt: string | null;
  rejectionReason: string | null;
  canLead: boolean;
  hasDeal: boolean;
}) {
  const [state, formAction, pending] = useActionState<MatchResult, FormData>(
    async (_prev, fd) => setMatchStatus(fd),
    { error: null },
  );
  const [picked, setPicked] = useState(status);

  if (!canLead) {
    return (
      <span className="tag" title="Вести подбор может агент, ведущий клиента, его автор или администратор">
        {MATCH_STATUS_RU[status] ?? status}
      </span>
    );
  }

  if (hasDeal) {
    return (
      <span className="tag" title="По подбору идёт сделка: статус ведёт она">
        {MATCH_STATUS_RU[status] ?? status}
      </span>
    );
  }

  const needsReason = picked === 'rejected';
  const needsDate = picked === 'showing_scheduled' || picked === 'showing_done';
  // Для «показ состоялся» дата может быть уже записана — тогда не просим.
  const dateAlready = Boolean(showingAt);

  return (
    <>
      <form action={formAction} className="inline">
        <input type="hidden" name="match_id" value={matchId} />
        <select
          name="status"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="Статус подбора"
        >
          {CHOICES.map((v) => (
            <option key={v} value={v}>{MATCH_STATUS_RU[v]}</option>
          ))}
          {status === 'in_deal' ? <option value="in_deal">в сделке</option> : null}
        </select>

        {needsReason ? (
          <input
            name="reason"
            type="text"
            required
            placeholder="причина отказа"
            defaultValue={rejectionReason ?? ''}
            style={{ minWidth: 180 }}
          />
        ) : null}

        {needsDate && !(picked === 'showing_done' && dateAlready) ? (
          <input
            name="showing_at"
            type="datetime-local"
            required={picked === 'showing_scheduled' && !dateAlready}
            defaultValue={showingAt ? showingAt.slice(0, 16) : ''}
          />
        ) : null}

        {picked !== status || needsReason || needsDate ? (
          <button type="submit" disabled={pending} className="ghost">
            {pending ? '…' : 'Сохранить'}
          </button>
        ) : null}
      </form>
      {state.error ? <p className="error">{state.error}</p> : null}
    </>
  );
}
