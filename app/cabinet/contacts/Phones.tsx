'use client';

import { useActionState } from 'react';
import { addPhone, removePhone, type ContactResult } from './actions';

export type Phone = { id: string; phone: string; label: string | null; is_primary: boolean };

/**
 * Телефоны контакта.
 *
 * Отдельный блок, потому что телефоны и живут в отдельной таблице: RLS в
 * Postgres построчный, и закрыть телефон, оставив контакт открытым, иначе
 * невозможно (инвариант 4).
 */
export function Phones({
  contactId,
  phones,
  canEdit,
}: {
  contactId: string;
  phones: Phone[];
  canEdit: boolean;
}) {
  const [addState, add, adding] = useActionState<ContactResult, FormData>(
    async (_p, fd) => addPhone(fd),
    { error: null },
  );
  const [delState, del, deleting] = useActionState<ContactResult, FormData>(
    async (_p, fd) => removePhone(fd),
    { error: null },
  );

  return (
    <>
      <h2>Телефоны</h2>
      <p className="key">
        Видны вам, участникам активной сделки по объекту этого контакта и
        администратору. Другим агентам — нет.
      </p>

      {phones.length === 0 ? (
        <p className="empty">Телефонов нет.</p>
      ) : (
        phones.map((p) => (
          <div className="row" key={p.id} style={{ marginBottom: 6 }}>
            <strong>{p.phone}</strong>
            {p.is_primary ? <span className="key">основной</span> : null}
            {p.label ? <span className="key">{p.label}</span> : null}
            {canEdit ? (
              <form
                action={del}
                style={{ display: 'inline' }}
                onSubmit={(e) => {
                  if (!window.confirm(`Удалить номер ${p.phone}?`)) e.preventDefault();
                }}
              >
                <input type="hidden" name="contact_id" value={contactId} />
                <input type="hidden" name="phone_id" value={p.id} />
                <button type="submit" disabled={deleting} className="ghost">удалить</button>
              </form>
            ) : null}
          </div>
        ))
      )}
      {delState.error ? <p className="error">{delState.error}</p> : null}

      {canEdit ? (
        <form action={add} className="inline" style={{ marginTop: 10 }}>
          <input type="hidden" name="contact_id" value={contactId} />
          <input name="phone" type="tel" required placeholder="+996 700 00 00 00" />
          <input name="label" type="text" placeholder="рабочий, WhatsApp" />
          <button type="submit" disabled={adding} className="ghost">
            {adding ? '…' : 'Добавить номер'}
          </button>
        </form>
      ) : null}
      {addState.error ? (
        <p className="error">
          {addState.error}
          {/* Глобальная уникальность номера — это и есть «один человек —
              одна запись», поэтому объясняем, а не просто показываем код. */}
          {addState.error.includes('one_contact_per_phone') ? (
            <>
              <br />
              <span className="key">
                Этот номер уже привязан к другому контакту. Один человек — одна
                запись: найдите существующий контакт и добавьте ему роль.
              </span>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
