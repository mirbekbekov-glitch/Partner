'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { lookupByPhone, type ContactResult, type LookupResult } from './actions';

export { ROLE_RU } from '@/lib/contact-roles';
import { ROLE_RU } from '@/lib/contact-roles';

export type ContactDraft = {
  id?: string;
  kind: string;
  name: string;
  telegram: string | null;
  source: string | null;
  roles: string[] | null;
  note: string | null;
};

export function ContactForm({
  action,
  draft,
  mode,
}: {
  action: (fd: FormData) => Promise<ContactResult>;
  draft?: ContactDraft;
  mode: 'create' | 'edit';
}) {
  const [state, formAction, pending] = useActionState<ContactResult, FormData>(
    async (_p, fd) => action(fd),
    { error: null },
  );
  const [found, setFound] = useState<LookupResult | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * Проверка телефона до сохранения. Телефон уникален глобально, поэтому
   * без этой подсказки агент узнавал бы о существующей записи только из
   * ошибки — а задача в том, чтобы он пошёл к существующему контакту и
   * добавил роль, а не завёл вторую запись того же человека.
   */
  async function checkPhone(phone: string) {
    if (phone.replace(/\D/g, '').length < 9) {
      setFound(null);
      return;
    }
    setChecking(true);
    setFound(await lookupByPhone(phone));
    setChecking(false);
  }

  return (
    <form action={formAction} className="stack">
      {draft?.id ? <input type="hidden" name="id" value={draft.id} /> : null}

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="kind">Кто это</label>
          <select id="kind" name="kind" defaultValue={draft?.kind ?? 'person'}>
            <option value="person">человек</option>
            <option value="company">компания</option>
          </select>
        </div>
        <div className="field">
          <label className="key" htmlFor="name">Имя или название</label>
          <input id="name" name="name" type="text" required defaultValue={draft?.name ?? ''} />
        </div>
      </div>

      {mode === 'create' ? (
        <div className="field">
          <label className="key" htmlFor="phone">Телефон</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            placeholder="+996 700 00 00 00"
            onBlur={(e) => checkPhone(e.target.value)}
          />
          {checking ? <p className="key">Проверяем, нет ли такого контакта…</p> : null}

          {found?.found ? (
            <div className="card" style={{ marginTop: 8 }}>
              <p className="warn">Этот номер уже есть в базе</p>
              {found.visible && found.contact_id ? (
                <p>
                  Это <strong>{found.name}</strong>.{' '}
                  <Link href={`/cabinet/contacts/${found.contact_id}`}>
                    открыть карточку →
                  </Link>
                  <br />
                  <span className="key">
                    Добавьте человеку нужную роль на его карточке — второй записи не нужно.
                  </span>
                </p>
              ) : (
                <p>
                  С этим человеком работает <strong>{found.owner_name}</strong>.
                  <br />
                  <span className="key">
                    Договоритесь с коллегой: один человек — одна запись. Сохранить
                    второй контакт с этим номером не получится.
                  </span>
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <fieldset className="field">
        <legend className="key">Роли</legend>
        <div className="inline">
          {Object.entries(ROLE_RU).map(([v, t]) => (
            <label className="check" key={v}>
              <input
                type="checkbox"
                name="roles"
                value={v}
                defaultChecked={(draft?.roles ?? []).includes(v)}
              />{' '}
              {t}
            </label>
          ))}
        </div>
        <p className="key">
          Роли — это флаги одной записи. Собственник, который завтра станет
          покупателем, получает вторую роль, а не вторую карточку. Можно не
          указывать ничего: контактное лицо по объекту роли контакта не имеет.
        </p>
      </fieldset>

      <div className="grid2">
        <div className="field">
          <label className="key" htmlFor="telegram">Telegram</label>
          <input id="telegram" name="telegram" type="text" placeholder="@nickname"
                 defaultValue={draft?.telegram ?? ''} />
        </div>
        <div className="field">
          <label className="key" htmlFor="source">Источник</label>
          <input id="source" name="source" type="text" placeholder="рекомендация, сайт, lalafo"
                 defaultValue={draft?.source ?? ''} />
        </div>
      </div>

      <div className="field">
        <label className="key" htmlFor="note">Заметка</label>
        <textarea id="note" name="note" rows={2} defaultValue={draft?.note ?? ''} />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Сохраняем…' : mode === 'create' ? 'Создать контакт' : 'Сохранить'}
        </button>
        <Link className="btn ghostlink" href={draft?.id ? `/cabinet/contacts/${draft.id}` : '/cabinet/contacts'}>
          отмена
        </Link>
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
