'use client';

import { useActionState } from 'react';
import { startDeal, type DealResult } from './actions';

/**
 * Кнопка «создать сделку» на подборе.
 *
 * Показывается только тому, кто может: сделку начинает listing-агент мандата
 * или агент, ведущий клиента. Остальным кнопка не нужна — она собирала бы
 * отказы.
 */
export function StartDealButton({
  matchId,
  objectId,
  requirementId,
}: {
  matchId: string;
  objectId: string;
  requirementId: string;
}) {
  const [state, formAction, pending] = useActionState<DealResult, FormData>(
    async (_prev, fd) => startDeal(fd),
    { error: null },
  );

  return (
    <>
      <form
        action={formAction}
        style={{ display: 'inline' }}
        onSubmit={(e) => {
          if (
            !window.confirm(
              'Создать сделку из этого подбора? Потребность клиента перейдёт в статус «в сделке».',
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="match_id" value={matchId} />
        <input type="hidden" name="object_id" value={objectId} />
        <input type="hidden" name="requirement_id" value={requirementId} />
        <button type="submit" disabled={pending} className="ghost">
          {pending ? '…' : 'Создать сделку'}
        </button>
      </form>
      {state.error ? <span className="error inline-error">{state.error}</span> : null}
    </>
  );
}
