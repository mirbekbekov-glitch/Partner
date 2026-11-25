import 'server-only';
import { all, batch, from_now, newId, now, one, run, stmt } from './sql';

/**
 * Напоминания о задачах: очередь, а не отправка на месте.
 *
 * Почему очередь. В Postgres исходящий запрос из базы сделать было нечем —
 * ни pg_net, ни http. Но разделение полезно и само по себе: база решает,
 * что и кому напомнить, — это проверяемо тестами; отправка в Telegram —
 * нет.
 *
 * Защита от повторной отправки держится тремя вещами:
 *   unique (activity_id, kind) — одно напоминание каждого вида на задачу,
 *   статус 'sending' при выдаче,
 *   счётчик попыток.
 *
 * Расписание может сработать дважды, отправщик — упасть на середине, и без
 * этого агент получил бы одно и то же несколько раз.
 *
 * Здесь нет проверок прав: это фоновое задание, сессии у него нет. Снаружи
 * до этих функций дойти нечем — их не вызывает ни одна страница и ни одно
 * действие формы, только расписание Worker.
 */

export type NotificationRow = {
  id: string;
  agent_id: string;
  activity_id: string;
  kind: 'due_soon' | 'overdue';
  channel: 'telegram' | 'email' | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'no_channel';
  body: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
};

/** Сколько попыток даём каналу, прежде чем замолчать. */
const MAX_ATTEMPTS = 3;

/** Срок в бишкекском времени: агенту показывают его часы, а не UTC. */
function bishkekTime(iso: string): string {
  const d = new Date(iso);
  const text = d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Bishkek',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  return text.replace(',', '');
}

/**
 * Поставить в очередь всё, чему подходит срок.
 *
 * Идемпотентно: повторный прогон расписания ничего не добавит — об этом
 * заботится `insert or ignore` поверх unique (activity_id, kind).
 *
 * Агент без привязанного Telegram получает запись со статусом
 * «нечем доставить», а не тишину: в списке задач это видно, и профиль
 * объясняет, что делать.
 */
export async function enqueueDueReminders(horizonMs = 24 * 60 * 60 * 1000): Promise<number> {
  const at = now();
  const horizon = from_now(horizonMs);

  const due = await all<{
    activity_id: string; agent_id: string; activity_kind: string;
    body: string | null; due_at: string; entity_type: string;
    telegram_id: number | null; entity_title: string | null;
  }>(
    `select a.id as activity_id, a.agent_id, a.kind as activity_kind, a.body,
            a.due_at, a.entity_type, ag.telegram_id,
            case a.entity_type
              when 'object'      then (select o.address from objects o where o.id = a.entity_id)
              when 'contact'     then (select c.name from contacts c where c.id = a.entity_id)
              when 'requirement' then (select coalesce(c.name, 'клиент') from requirements r
                                         left join contacts c on c.id = r.contact_id
                                        where r.id = a.entity_id)
              when 'deal'        then (select o.address from deals d
                                         join objects o on o.id = d.object_id
                                        where d.id = a.entity_id)
              when 'match'       then (select o.address from matches m
                                         join objects o on o.id = m.object_id
                                        where m.id = a.entity_id)
              when 'mandate'     then (select o.address from mandates md
                                         join objects o on o.id = md.object_id
                                        where md.id = a.entity_id)
            end as entity_title
       from activities a
       join agents ag on ag.id = a.agent_id
      where a.kind in ('task', 'showing')
        and a.due_at is not null
        and a.done = 0
        -- Заблокированному и неодобренному агенту напоминать не о чем.
        and ag.status = 'approved'
        and a.due_at < ?`,
    horizon,
  );
  if (due.length === 0) return 0;

  const writes = due.map((row) => {
    const overdue = row.due_at < at;
    const channel = row.telegram_id !== null ? 'telegram' : null;

    // Текст собирается здесь, чтобы отправщик остался простым и не лазил
    // в данные сам.
    const body = [
      overdue ? 'Просрочено: ' : 'Скоро срок: ',
      row.activity_kind === 'showing' ? 'показ' : 'задача',
      row.entity_title ? ` по «${row.entity_title}»` : '',
      row.body ? `\n${row.body}` : '',
      `\nСрок: ${bishkekTime(row.due_at)}`,
    ].join('');

    return stmt(
      `insert or ignore into notifications
         (id, agent_id, activity_id, kind, channel, status, body, attempts, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      newId(), row.agent_id, row.activity_id,
      overdue ? 'overdue' : 'due_soon', channel,
      channel === null ? 'no_channel' : 'pending',
      body, at,
    );
  });

  await batch(writes);

  const added = await one<{ n: number }>(
    `select count(*) as n from notifications where created_at = ?`, at,
  );
  return added?.n ?? 0;
}

/**
 * Взять партию на отправку.
 *
 * Статус сразу переводится в 'sending', и попытка засчитывается: если
 * отправщик упадёт между выдачей и отправкой, запись не достанется второму
 * заходу и агент не получит дубль.
 */
export async function claimNotifications(limit = 50): Promise<Array<{
  id: string; channel: string | null; body: string;
  telegram_id: number | null; attempts: number;
}>> {
  const picked = await all<{ id: string }>(
    `select id from notifications
      where status = 'pending' and attempts < ?
      order by created_at limit ?`,
    MAX_ATTEMPTS, limit,
  );
  if (picked.length === 0) return [];

  const holders = picked.map(() => '?').join(', ');
  const ids = picked.map((p) => p.id);

  await run(
    `update notifications set status = 'sending', attempts = attempts + 1
      where id in (${holders})`,
    ...ids,
  );

  return all(
    `select n.id, n.channel, n.body, a.telegram_id, n.attempts
       from notifications n join agents a on a.id = n.agent_id
      where n.id in (${holders})`,
    ...ids,
  );
}

/** Итог отправки. Исчерпал попытки — больше не берём, чтобы не долбить мёртвый канал. */
export async function markNotification(
  id: string,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  await run(
    `update notifications
        set status = case
              when ?2 = 1 then 'sent'
              when attempts >= ?3 then 'failed'
              else 'pending' end,
            sent_at = case when ?2 = 1 then ?4 else sent_at end,
            last_error = case when ?2 = 1 then null else ?5 end
      where id = ?1`,
    id, ok ? 1 : 0, MAX_ATTEMPTS, now(), (error ?? '').slice(0, 500) || null,
  );
}

/** Мои напоминания — для страницы задач. */
export async function myNotifications(agentId: string): Promise<NotificationRow[]> {
  return all<NotificationRow>(
    `select * from notifications where agent_id = ? order by created_at desc limit 50`,
    agentId,
  );
}
