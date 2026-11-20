'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { setOwnership, removeOwnership, type OwnershipResult } from './actions';

export const OWNERSHIP_RU: Record<string, string> = {
  owner: 'собственник',
  co_owner: 'совладелец',
  proxy: 'доверенное лицо',
  contact_person: 'контактное лицо',
};

export type OwnershipRow = {
  object_id: string;
  ownership_role: string;
  share: number | null;
  address: string;
  deal_type: string;
  price: number;
  currency: string;
  publication_state: string;
  active_mandate_id: string | null;
  contract_confirmed: boolean | null;
};

export type LinkableObject = {
  id: string;
  address: string;
  deal_type: string;
  price: number;
  currency: string;
};

const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

function RoleRow({
  contactId,
  row,
  canEdit,
}: {
  contactId: string;
  row: OwnershipRow;
  canEdit: boolean;
}) {
  const [setState, save, saving] = useActionState<OwnershipResult, FormData>(
    async (_p, fd) => setOwnership(fd),
    { error: null },
  );
  const [delState, del, deleting] = useActionState<OwnershipResult, FormData>(
    async (_p, fd) => removeOwnership(fd),
    { error: null },
  );

  return (
    <div className="card">
      <div className="row">
        <Link href={`/cabinet/objects/${row.object_id}`}>
          <strong>{row.address}</strong>
        </Link>
        <span>{money(row.price, row.currency)}</span>
        <span className="key">{row.deal_type === 'sale' ? 'продажа' : 'аренда'}</span>
        <span className="key">{row.publication_state}</span>
      </div>

      {!row.active_mandate_id ? (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="warn">нет активного мандата — объект нельзя опубликовать</span>
        </div>
      ) : row.contract_confirmed === false ? (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="warn">договор требует подтверждения</span>
        </div>
      ) : null}

      {canEdit ? (
        <>
          {/* Две ОТДЕЛЬНЫЕ формы рядом, а не вложенные: вложенный <form>
              невалиден, и браузеры разбирают такую разметку по-разному. */}
          <div className="inline" style={{ marginTop: 8 }}>
            <form action={save} className="inline">
              <input type="hidden" name="contact_id" value={contactId} />
              <input type="hidden" name="object_id" value={row.object_id} />
              <label className="key" htmlFor={`role-${row.object_id}`}>роль</label>
              <select id={`role-${row.object_id}`} name="role" defaultValue={row.ownership_role}>
                {Object.entries(OWNERSHIP_RU).map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </select>
              <label className="key" htmlFor={`share-${row.object_id}`}>доля</label>
              <input id={`share-${row.object_id}`} name="share" type="text"
                     inputMode="decimal" placeholder="не указана"
                     defaultValue={row.share ?? ''} style={{ width: 90 }} />
              <button type="submit" disabled={saving} className="ghost">
                {saving ? '…' : 'сохранить'}
              </button>
            </form>

            <form
              action={del}
              onSubmit={(e) => {
                if (!window.confirm(`Снять связь с объектом «${row.address}»?`)) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="contact_id" value={contactId} />
              <input type="hidden" name="object_id" value={row.object_id} />
              <button type="submit" disabled={deleting} className="ghost">снять связь</button>
            </form>
          </div>
          {setState.error ? <p className="error">{setState.error}</p> : null}
          {delState.error ? <p className="error">{delState.error}</p> : null}
        </>
      ) : (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="key">
            {OWNERSHIP_RU[row.ownership_role] ?? row.ownership_role}
            {row.share != null ? `, доля ${row.share}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function Ownerships({
  contactId,
  rows,
  linkable,
  canEdit,
}: {
  contactId: string;
  rows: OwnershipRow[];
  linkable: LinkableObject[];
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState<OwnershipResult, FormData>(
    async (_p, fd) => setOwnership(fd),
    { error: null },
  );
  const [open, setOpen] = useState(false);

  const linked = new Set(rows.map((r) => r.object_id));
  const free = linkable.filter((o) => !linked.has(o.id));

  return (
    <>
      <h2>Объекты ({rows.length})</h2>

      {rows.length === 0 ? (
        <p className="empty">Объектов за этим контактом нет.</p>
      ) : (
        rows.map((r) => (
          <RoleRow key={`${r.object_id}-${r.ownership_role}`} contactId={contactId}
                   row={r} canEdit={canEdit} />
        ))
      )}

      {canEdit && free.length > 0 ? (
        !open ? (
          <button type="button" className="ghost" onClick={() => setOpen(true)}>
            Связать с объектом
          </button>
        ) : (
          <>
            <p className="key">
              Предлагаются только объекты, за которые вы отвечаете. Доля задаётся числом
              от 0 до 1 и в сумме по объекту не может выйти за единицу — можно оставить
              пустой, если она неизвестна.
            </p>
            <form action={formAction} className="inline">
              <input type="hidden" name="contact_id" value={contactId} />
              <select name="object_id" required defaultValue="">
                <option value="" disabled>— выберите объект —</option>
                {free.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.address} · {money(o.price, o.currency)}
                  </option>
                ))}
              </select>
              <select name="role" defaultValue="owner">
                {Object.entries(OWNERSHIP_RU).map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </select>
              <input name="share" type="text" inputMode="decimal" placeholder="доля"
                     style={{ width: 90 }} />
              <button type="submit" disabled={pending}>
                {pending ? '…' : 'Связать'}
              </button>
              <button type="button" className="ghost" onClick={() => setOpen(false)}>
                отмена
              </button>
            </form>
            {state.error ? <p className="error">{state.error}</p> : null}
          </>
        )
      ) : null}

      {canEdit && free.length === 0 && linkable.length > 0 ? (
        <p className="key">Все ваши объекты уже связаны с этим контактом.</p>
      ) : null}
    </>
  );
}
