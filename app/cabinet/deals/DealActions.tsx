'use client';

import { useActionState, useState } from 'react';
import { advanceDeal, closeDeal, failDeal, type DealResult } from './actions';

const STAGES: [string, string][] = [
  ['deposit', 'аванс'],
  ['documents', 'документы'],
  ['signing', 'подписание'],
  ['settlement', 'расчёт'],
];

function Stage({ dealId, status, label }: { dealId: string; status: string; label: string }) {
  const [state, formAction, pending] = useActionState<DealResult, FormData>(
    async (_prev, fd) => advanceDeal(fd),
    { error: null },
  );
  return (
    <>
      <form action={formAction} style={{ display: 'inline' }}>
        <input type="hidden" name="id" value={dealId} />
        <input type="hidden" name="status" value={status} />
        <button type="submit" disabled={pending} className="ghost">
          {pending ? '…' : label}
        </button>
      </form>
      {state.error ? <span className="error inline-error">{state.error}</span> : null}
    </>
  );
}

export function DealActions({
  dealId,
  status,
  objectPrice,
  currency,
}: {
  dealId: string;
  status: string;
  objectPrice: number;
  currency: string;
}) {
  const [closeState, closeAction, closing] = useActionState<DealResult, FormData>(
    async (_prev, fd) => closeDeal(fd),
    { error: null },
  );
  const [failState, failAction, failing] = useActionState<DealResult, FormData>(
    async (_prev, fd) => failDeal(fd),
    { error: null },
  );
  const [showFail, setShowFail] = useState(false);

  if (status === 'closed' || status === 'failed') {
    return <p className="key">Сделка завершена. Этапы и суммы больше не меняются.</p>;
  }

  return (
    <>
      <h2>Этап</h2>
      <div className="actions">
        {STAGES.filter(([v]) => v !== status).map(([v, t]) => (
          <Stage key={v} dealId={dealId} status={v} label={t} />
        ))}
      </div>

      <h2>Закрыть сделку</h2>
      <p className="key">
        Комиссия будет посчитана от финальной цены и зафиксирована: цена объекта
        на неё больше не повлияет. Мандат и потребность закроются.
      </p>
      <form
        action={closeAction}
        className="inline"
        onSubmit={(e) => {
          if (!window.confirm('Закрыть сделку? Суммы комиссии фиксируются окончательно.')) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="id" value={dealId} />
        <label className="key" htmlFor="final_price">Финальная цена</label>
        <input
          id="final_price"
          name="final_price"
          type="text"
          inputMode="decimal"
          required
          defaultValue={objectPrice}
          placeholder={String(objectPrice)}
        />
        <span className="key">{currency}</span>
        <button type="submit" disabled={closing}>
          {closing ? 'Закрываем…' : 'Закрыть'}
        </button>
      </form>
      {closeState.error ? <p className="error">{closeState.error}</p> : null}

      <h2>Сорвалась</h2>
      {!showFail ? (
        <button type="button" className="ghost" onClick={() => setShowFail(true)}>
          Отметить срыв
        </button>
      ) : (
        <>
          <p className="key">
            Потребность вернётся в работу со статусом «квалифицирована» — клиент остался.
          </p>
          <form action={failAction} className="inline">
            <input type="hidden" name="id" value={dealId} />
            <input name="reason" type="text" required placeholder="причина срыва"
                   style={{ minWidth: 220 }} />
            <button type="submit" disabled={failing}>
              {failing ? '…' : 'Подтвердить срыв'}
            </button>
            <button type="button" className="ghost" onClick={() => setShowFail(false)}>
              отмена
            </button>
          </form>
          {failState.error ? <p className="error">{failState.error}</p> : null}
        </>
      )}
    </>
  );
}
