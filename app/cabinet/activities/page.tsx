import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { ActivityRowView, KIND_RU, type ActivityRow } from '../Activities';

export const metadata = { title: 'Задачи' };

const ENTITY_PATH: Record<string, string> = {
  object: 'objects',
  requirement: 'requirements',
  deal: 'deals',
};

/**
 * Личный список дел.
 *
 * Собирает активности по всем сущностям, а не по одной карточке: иначе
 * просроченную задачу можно увидеть только зайдя на тот объект, про который
 * уже забыл.
 */
export default async function ActivitiesPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('activity_feed_v')
    .select('*')
    .eq('mine', true)
    .order('done', { ascending: true })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return (
      <>
        <h1>Задачи</h1>
        <p className="error">{error.message}</p>
      </>
    );
  }

  const rows = (data ?? []) as ActivityRow[];
  const overdue = rows.filter((r) => r.overdue);
  const dueSoon = rows.filter((r) => !r.done && !r.overdue && r.due_at);
  const noDate = rows.filter((r) => !r.done && !r.due_at);
  const done = rows.filter((r) => r.done);

  return (
    <>
      <h1>Задачи</h1>
      <p className="sub">
        Ваши записи по всем объектам, потребностям и сделкам. Записать новую можно на
        карточке — там видно, к чему она относится.
      </p>

      <Section title={`Просрочено (${overdue.length})`} rows={overdue} warn />
      <Section title={`Со сроком (${dueSoon.length})`} rows={dueSoon} />
      <Section title={`Без срока (${noDate.length})`} rows={noDate} />

      {done.length > 0 ? (
        <Section title={`Выполнено (${done.length})`} rows={done.slice(0, 30)} />
      ) : null}

      {rows.length === 0 ? (
        <p className="empty">
          Записей пока нет. Звонки, показы и задачи записываются на карточке объекта,
          потребности или сделки.
        </p>
      ) : null}
    </>
  );
}

function Section({
  title,
  rows,
  warn,
}: {
  title: string;
  rows: ActivityRow[];
  warn?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <h2>
        {warn ? <span className="warn">{title}</span> : title}
      </h2>
      {rows.map((a) => (
        <div className="card" key={a.id}>
          {/* Куда относится запись — важнее её текста: иначе список дел
              превращается в набор фраз без контекста. */}
          <div className="row">
            {a.entity_title && a.entity_type && ENTITY_PATH[a.entity_type] ? (
              <Link href={`/cabinet/${ENTITY_PATH[a.entity_type]}/${a.entity_id}`}>
                <strong>{a.entity_title}</strong>
              </Link>
            ) : (
              <strong>{a.entity_title ?? 'запись скрыта'}</strong>
            )}
            <span className="key">{KIND_RU[a.kind] ?? a.kind}</span>
          </div>
          <ActivityRowView a={a} />
        </div>
      ))}
    </>
  );
}
