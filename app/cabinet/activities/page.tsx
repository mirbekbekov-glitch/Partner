import Link from 'next/link';
import { myActivities, myReminders } from '@/lib/db/cabinet';
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
  let rows: ActivityRow[] = [];
  let reminders: Array<{
    activity_id: string; kind: string; status: string;
    channel: string | null; last_error: string | null;
  }> = [];
  let failed: string | null = null;

  try {
    // Состояние напоминаний рядом со списком: молчание хуже всего — агент
    // должен видеть, отправлено ли напоминание и если нет, то почему.
    [rows, reminders] = await Promise.all([
      myActivities() as unknown as Promise<ActivityRow[]>,
      myReminders(),
    ]);
  } catch (e) {
    failed = e instanceof Error ? e.message : 'Не удалось загрузить задачи.';
  }

  if (failed) {
    return (
      <>
        <h1>Задачи</h1>
        <p className="error">{failed}</p>
      </>
    );
  }

  const byActivity = new Map(reminders.map((r) => [r.activity_id, r]));
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

      <Section title={`Просрочено (${overdue.length})`} rows={overdue}
               reminders={byActivity} warn />
      <Section title={`Со сроком (${dueSoon.length})`} rows={dueSoon}
               reminders={byActivity} />
      <Section title={`Без срока (${noDate.length})`} rows={noDate}
               reminders={byActivity} />

      {done.length > 0 ? (
        <Section title={`Выполнено (${done.length})`} rows={done.slice(0, 30)}
                 reminders={byActivity} />
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

const REMINDER_RU: Record<string, string> = {
  pending: 'напоминание в очереди',
  sending: 'напоминание отправляется',
  sent: 'напоминание отправлено',
  failed: 'напоминание не доставлено',
  cancelled: 'напоминание отменено',
  no_channel: 'напомнить нечем: Telegram не привязан',
};

function Section({
  title,
  rows,
  reminders,
  warn,
}: {
  title: string;
  rows: ActivityRow[];
  reminders: Map<string, { status: string; last_error: string | null }>;
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
          {(() => {
            const r = reminders.get(a.id);
            if (!r) return null;
            const problem = r.status === 'no_channel' || r.status === 'failed';
            return (
              <div className="row" style={{ marginTop: 4 }}>
                <span className={problem ? 'warn' : 'key'}>
                  {REMINDER_RU[r.status] ?? r.status}
                </span>
                {r.last_error ? <span className="key">{r.last_error}</span> : null}
                {r.status === 'no_channel' ? (
                  <Link className="key" href="/cabinet/profile">как это исправить →</Link>
                ) : null}
              </div>
            );
          })()}
        </div>
      ))}
    </>
  );
}
