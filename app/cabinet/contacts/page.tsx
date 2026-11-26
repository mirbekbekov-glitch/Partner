import Link from 'next/link';
import { contactDuplicates, contactList } from '@/lib/db/cabinet';
import { ROLE_RU } from './ContactForm';

export const metadata = { title: 'Контакты' };

type Row = {
  id: string;
  kind: string;
  name: string;
  telegram: string | null;
  source: string | null;
  roles: string[] | null;
  phones: string | null;
  owner_name: string | null;
  mine: boolean;
  objects_count: number;
  requirements_count: number;
  open_requirements: number;
};

export default async function ContactsList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || null;
  };
  const q = one('q');
  const role = one('role');

  // Видимость стоит в самом запросе: чужие контакты закрыты инвариантом 4.
  // Раньше их отсекала политика базы, и условия здесь не было.
  let rows: Row[] = [];
  let dupes: Array<{ a_id: string; b_id: string }> = [];
  let error: string | null = null;

  try {
    // Пары дубликатов — рядом со списком: пометить их полезнее, чем ждать,
    // пока кто-то зайдёт на карточку и заметит сам.
    [rows, dupes] = await Promise.all([
      contactList(q) as unknown as Promise<Row[]>,
      contactDuplicates(),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить контакты.';
  }

  if (role && role in ROLE_RU) {
    rows = rows.filter((r) => (r.roles ?? []).includes(role));
  }

  const count = rows.length;

  // Запись участвует в паре с любой стороны.
  const dupeIds = new Set<string>();
  for (const d of dupes) {
    dupeIds.add(d.a_id);
    dupeIds.add(d.b_id);
  }

  return (
    <>
      <div className="head">
        <h1>Контакты</h1>
        <Link className="btn" href="/cabinet/contacts/new">Новый контакт</Link>
      </div>
      <p className="sub">
        Всего {count ?? 0}. Видны те, кого привели вы, и те, по объектам которых у вас
        идёт сделка.
      </p>

      <form className="filters" method="get">
        <input name="q" type="search" placeholder="имя" defaultValue={q ?? ''} />
        <select name="role" defaultValue={role ?? ''}>
          <option value="">роль: любая</option>
          {Object.entries(ROLE_RU).map(([v, t]) => (
            <option key={v} value={v}>{t}</option>
          ))}
        </select>
        <button type="submit">Фильтр</button>
        {q || role ? (
          <Link href="/cabinet/contacts" className="key reset">сбросить</Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          {count === 0 && !q && !role
            ? 'Контактов пока нет. Собственник или клиент заводится вместе с объектом или потребностью — либо здесь.'
            : 'Под эти условия ничего не подошло.'}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Роли</th>
                <th>Телефон</th>
                <th>Telegram</th>
                <th className="num">Объектов</th>
                <th className="num">Потребностей</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="tbl-main" href={`/cabinet/contacts/${c.id}`}>
                      {c.name}
                    </Link>
                    {c.kind === 'company' ? (
                      <span className="tbl-sub">компания</span>
                    ) : null}
                    {!c.mine ? (
                      <span className="tbl-sub">привёл {c.owner_name}</span>
                    ) : null}
                    {dupeIds.has(c.id) ? (
                      <span className="tbl-note">
                        <span
                          className="warn"
                          title="Есть запись с таким же именем — возможно, это один человек"
                        >
                          похоже на дубликат
                        </span>
                      </span>
                    ) : null}
                  </td>
                  <td data-l="Роли">
                    {(c.roles ?? []).length > 0 ? (
                      (c.roles ?? []).map((r) => (
                        <span className="tag" key={r}>{ROLE_RU[r] ?? r}</span>
                      ))
                    ) : (
                      <span className="key">не указана</span>
                    )}
                  </td>
                  <td data-l="Телефон">{c.phones ?? '—'}</td>
                  <td data-l="Telegram">{c.telegram ?? '—'}</td>
                  <td className="num" data-l="Объектов">{c.objects_count}</td>
                  <td className="num" data-l="Потребностей">
                    {c.requirements_count}
                    {c.open_requirements > 0 ? ` (${c.open_requirements} в работе)` : ''}
                  </td>
                  <td data-l="Источник">{c.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
