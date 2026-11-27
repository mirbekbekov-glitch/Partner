import Link from 'next/link';
import {
  myActivities, myActivityCounts, myReminders, type ActivityScope,
} from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import {
  ActivityActions, ActivityMeta,
  type ActivityRow, type Colleague,
} from '../Activities';
import { KIND_RU } from '@/lib/activity-kinds';
import { activityWhen } from '@/lib/activity-format';
import { parseFilters } from '@/lib/list-params';
import { Pager } from '../Pager';

export const metadata = { title: 'Задачи' };

const BASE = '/cabinet/activities';

/**
 * Разделы стали вкладками.
 *
 * Раньше все три показывались сразу, но список брал из базы двести записей
 * и делился уже в браузере: на двести первой просроченная задача просто
 * перестала бы показываться. Теперь условие ушло в запрос, вкладка
 * листается страницами, а числа в подписях считает база — они не зависят
 * от того, что уместилось на экране.
 */
const TABS: [ActivityScope, string][] = [
  ['overdue', 'Просрочено'],
  ['due', 'Со сроком'],
  ['nodate', 'Без срока'],
];

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
export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const tab = (TABS.find(([v]) => v === f.tab)?.[0] ?? 'overdue') as ActivityScope;

  let rows: ActivityRow[] = [];
  let total = 0;
  let counts = { overdue: 0, due: 0, nodate: 0 };
  let reminders: Array<{
    activity_id: string; kind: string; status: string;
    channel: string | null; last_error: string | null;
  }> = [];
  let colleagues: Colleague[] = [];
  let failed: string | null = null;

  try {
    // Состояние напоминаний рядом со списком: молчание хуже всего — агент
    // должен видеть, отправлено ли напоминание и если нет, то почему.
    const [listed, rem, mates, tallies] = await Promise.all([
      myActivities(tab, f.page),
      myReminders(),
      approvedColleagues(),
      myActivityCounts(),
    ]);
    rows = listed.rows;
    total = listed.total;
    reminders = rem;
    colleagues = mates;
    counts = tallies;
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

  return (
    <>
      <h1>Задачи</h1>
      <p className="sub">
        Ваши записи по всем объектам, потребностям и сделкам. Записать новую можно на
        карточке — там видно, к чему она относится.
      </p>

      <div className="tabs-row">
        {TABS.map(([v, label]) => (
          <Link
            key={v}
            href={v === 'overdue' ? BASE : `${BASE}?tab=${v}`}
            className="chip"
            aria-current={tab === v ? 'true' : undefined}
          >
            {label} {counts[v]}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          {counts.overdue + counts.due + counts.nodate === 0
            ? 'Записей пока нет. Звонки, показы и задачи записываются на карточке объекта, потребности или сделки.'
            : 'В этой вкладке пусто.'}
        </p>
      ) : (
        <Section
          rows={rows}
          reminders={byActivity}
          colleagues={colleagues}
        />
      )}

      <Pager base={BASE} filters={{ ...f, tab }} total={total} />
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
  rows,
  reminders,
  colleagues,
}: {
  rows: ActivityRow[];
  reminders: Map<string, { status: string; last_error: string | null }>;
  colleagues: Colleague[];
}) {
  if (rows.length === 0) return null;

  return (
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
  );
}
