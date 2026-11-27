import Link from 'next/link';
import { myActivities, myReminders } from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import {
  ActivityActions, ActivityMeta, activityWhen, KIND_RU,
  type ActivityRow, type Colleague,
} from '../Activities';

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
  let colleagues: Colleague[] = [];
  let failed: string | null = null;

  try {
    // Состояние напоминаний рядом со списком: молчание хуже всего — агент
    // должен видеть, отправлено ли напоминание и если нет, то почему.
    [rows, reminders, colleagues] = await Promise.all([
      myActivities() as unknown as Promise<ActivityRow[]>,
      myReminders(),
      approvedColleagues(),
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
               reminders={byActivity} colleagues={colleagues} warn />
      <Section title={`Со сроком (${dueSoon.length})`} rows={dueSoon}
               reminders={byActivity} colleagues={colleagues} />
      <Section title={`Без срока (${noDate.length})`} rows={noDate}
               reminders={byActivity} colleagues={colleagues} />

      {/* Этот раздел сейчас не показывается никогда: myActivities отдаёт
          только незакрытые (`and a.done = 0`), поэтому done всегда пуст.
          Разметка оставлена как есть — решать, показывать ли выполненные
          в личном списке, надо продуктово, а не заодно. Передачи у
          закрытой записи всё равно нет: ActivityActions её не рисует. */}
      {done.length > 0 ? (
        <Section title={`Выполнено (${done.length})`} rows={done.slice(0, 30)}
                 reminders={byActivity} colleagues={colleagues} />
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

/**
 * Один раздел списка дел — таблицей.
 *
 * Колонка «К чему» идёт первой намеренно: иначе список дел превращается в
 * набор фраз без контекста, и непонятно, по какому объекту звонить.
 */
function Section({
  title,
  rows,
  reminders,
  colleagues,
  warn,
}: {
  title: string;
  rows: ActivityRow[];
  reminders: Map<string, { status: string; last_error: string | null }>;
  colleagues: Colleague[];
  warn?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <h2>
        {warn ? <span className="warn">{title}</span> : title}
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>К чему</th>
              <th>Тип</th>
              <th>Запись</th>
              <th>Состояние</th>
              <th>Напоминание</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const r = reminders.get(a.id);
              const problem = r?.status === 'no_channel' || r?.status === 'failed';

              return (
                <tr key={a.id}>
                  <td>
                    {a.entity_title && a.entity_type && ENTITY_PATH[a.entity_type] ? (
                      <Link
                        className="tbl-main"
                        href={`/cabinet/${ENTITY_PATH[a.entity_type]}/${a.entity_id}`}
                      >
                        {a.entity_title}
                      </Link>
                    ) : (
                      <span className="tbl-main">{a.entity_title ?? 'запись скрыта'}</span>
                    )}
                    {!a.mine ? <span className="tbl-sub">{a.agent_name}</span> : null}
                  </td>
                  <td data-l="Тип">
                    <span className="tag">{KIND_RU[a.kind] ?? a.kind}</span>
                  </td>
                  <td data-l="Запись">
                    {a.body ? <span className="tbl-text">{a.body}</span> : '—'}
                  </td>
                  <td data-l="Состояние">
                    {a.done ? (
                      <span className="key">выполнено {activityWhen(a.done_at)}</span>
                    ) : null}
                    {a.overdue ? (
                      <span className="tbl-note"><span className="warn">просрочено</span></span>
                    ) : null}
                    {a.due_at && !a.done ? (
                      <span className="nowrap">{activityWhen(a.due_at)}</span>
                    ) : null}
                    {a.is_shared ? <span className="tbl-sub">общая</span> : null}
                  </td>
                  <td data-l="Напоминание">
                    {r ? (
                      <>
                        <span className={problem ? 'warn' : 'key'}>
                          {REMINDER_RU[r.status] ?? r.status}
                        </span>
                        {r.last_error ? (
                          <span className="tbl-sub">{r.last_error}</span>
                        ) : null}
                        {r.status === 'no_channel' ? (
                          <span className="tbl-note">
                            <Link className="key" href="/cabinet/profile">
                              как это исправить →
                            </Link>
                          </span>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-l="Действия">
                    <ActivityActions a={a} colleagues={colleagues} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
