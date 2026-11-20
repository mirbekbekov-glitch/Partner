'use client';

import { useActionState, useState } from 'react';
import type { TransferResult } from './transfer-actions';

export type Colleague = { id: string; full_name: string; role: string };

/**
 * Передача работы коллеге.
 *
 * Спрятано за кнопкой: действие редкое и заметное, незачем держать выбор
 * агента на виду рядом с обычной правкой. Подтверждение обязательно —
 * после передачи ни клиент, ни объект больше не ваши, включая телефоны и
 * долю в комиссии.
 */
export function TransferForm({
  action,
  idField,
  idValue,
  colleagues,
  what,
  warning,
}: {
  action: (fd: FormData) => Promise<TransferResult>;
  idField: 'contact_id' | 'object_id';
  idValue: string;
  colleagues: Colleague[];
  what: string;
  warning: string;
}) {
  const [state, formAction, pending] = useActionState<TransferResult, FormData>(
    async (_prev, fd) => action(fd),
    { error: null, done: null },
  );
  const [open, setOpen] = useState(false);

  if (state.done) {
    return <p className="key">{state.done}</p>;
  }

  if (colleagues.length === 0) {
    return <p className="key">Передавать некому: одобренных коллег пока нет.</p>;
  }

  if (!open) {
    return (
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        Передать {what} коллеге
      </button>
    );
  }

  return (
    <>
      <p className="key">{warning}</p>
      <form
        action={formAction}
        className="inline"
        onSubmit={(e) => {
          const sel = (e.currentTarget.elements.namedItem('to_agent_id') as HTMLSelectElement);
          const name = sel?.selectedOptions[0]?.text ?? 'коллеге';
          if (!window.confirm(`Передать ${what} — ${name}? ${warning}`)) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name={idField} value={idValue} />
        <label className="key" htmlFor="to_agent_id">Кому</label>
        <select id="to_agent_id" name="to_agent_id" required defaultValue="">
          <option value="" disabled>— выберите коллегу —</option>
          {colleagues.map((c) => (
            <option key={c.id} value={c.id}>
              {c.full_name}{c.role === 'admin' ? ' (админ)' : ''}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending}>
          {pending ? 'Передаём…' : 'Передать'}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          отмена
        </button>
      </form>
      {state.error ? <p className="error">{state.error}</p> : null}
    </>
  );
}
