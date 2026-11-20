-- 0024_reminders.sql
-- Напоминания о задачах: очередь в базе.
--
-- Почему очередь, а не отправка «на месте». В этом контейнере нет ни pg_net,
-- ни http — из Postgres исходящий запрос сделать нечем, и на Supabase это
-- тоже отдельное расширение. Поэтому база только РЕШАЕТ, что и кому пора
-- напомнить, а отправляет Next.js по расписанию. Разделение полезно и само
-- по себе: решение о напоминании проверяемо тестами, а отправка — нет.
--
-- Очередь нужна и ради того, чтобы не напомнить дважды. Расписание может
-- сработать повторно, маршрут — упасть на середине; без записи о том, что
-- уже отправлено, агент получит одно и то же несколько раз.

create type notification_kind   as enum ('due_soon', 'overdue');
create type notification_channel as enum ('telegram', 'email');
create type notification_status as enum (
  'pending',    -- ждёт отправки
  'sending',    -- взято в работу: защита от двойной отправки
  'sent',
  'failed',
  'cancelled',  -- задача выполнена или удалена, напоминать незачем
  'no_channel'  -- агенту нечем доставить: Telegram не привязан
);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references agents (id) on delete cascade,
  -- Напоминание живёт ровно столько, сколько задача: удалили задачу —
  -- исчезло и напоминание.
  activity_id uuid not null references activities (id) on delete cascade,
  kind        notification_kind not null,
  channel     notification_channel,
  status      notification_status not null default 'pending',
  body        text not null,
  attempts    smallint not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,

  -- Защита от повторной отправки: одно напоминание каждого вида на задачу.
  -- Именно этот индекс делает app.enqueue_due_reminders() идемпотентной.
  unique (activity_id, kind)
);

comment on table notifications is
  'Очередь напоминаний. unique (activity_id, kind) — единственная защита от того, чтобы напомнить дважды; на неё опирается идемпотентность enqueue.';

create index notifications_pending_idx on notifications (status, created_at)
  where status in ('pending', 'sending');
create index notifications_agent_idx on notifications (agent_id, created_at desc);

alter table notifications enable row level security;

-- Агент видит свои напоминания и больше ничьи: в тексте напоминания стоит
-- текст его задачи.
create policy notifications_read on notifications for select
  using (agent_id = app.current_agent_id() or app.is_admin());

grant select on notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Что считается поводом напомнить
-- ---------------------------------------------------------------------------
-- Задачи и показы со сроком, не выполненные, у действующего агента.
-- Заметки, звонки и сообщения срока не имеют — напоминать о них нечего.
--
-- Два повода, каждый ровно один раз: «скоро» и «просрочено». Их различие
-- несёт смысл: первое можно успеть сделать, второе уже нет.

create or replace function app.enqueue_due_reminders(
  p_horizon interval default interval '24 hours'
) returns table (
  -- Имена с префиксом нарочно: выходной параметр с именем kind сталкивается
  -- со колонкой kind внутри запроса, и Postgres отвечает «ambiguous».
  r_kind     notification_kind,
  r_enqueued integer
)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with candidates as (
    select
      a.id   as activity_id,
      a.agent_id,
      a.kind as activity_kind,
      a.body,
      a.due_at,
      a.entity_type,
      a.entity_id,
      case when a.due_at < now() then 'overdue'::notification_kind
           else 'due_soon'::notification_kind end as nkind,
      -- Канал: Telegram, если привязан. Почта как канал не реализована,
      -- поэтому агент без Telegram получает запись no_channel, а не тишину.
      case when ag.telegram_id is not null then 'telegram'::notification_channel
           else null end as channel
    from activities a
    join agents ag on ag.id = a.agent_id
   where a.kind in ('task', 'showing')
     and a.due_at is not null
     and not a.done
     -- Заблокированному и неодобренному агенту напоминать не о чем.
     and ag.status = 'approved'
     and a.due_at < now() + p_horizon
  ), titled as (
    select c.*,
      case c.entity_type
        when 'object'      then (select o.address from objects o where o.id = c.entity_id)
        when 'requirement' then (select coalesce(ct.name, 'клиент')
                                   from requirements r
                                   left join contacts ct on ct.id = r.contact_id
                                  where r.id = c.entity_id)
        when 'contact'     then (select ct.name from contacts ct where ct.id = c.entity_id)
        when 'deal'        then (select o.address from deals d
                                   join objects o on o.id = d.object_id
                                  where d.id = c.entity_id)
        when 'match'       then (select o.address from matches m
                                   join objects o on o.id = m.object_id
                                  where m.id = c.entity_id)
        when 'mandate'     then (select o.address from mandates md
                                   join objects o on o.id = md.object_id
                                  where md.id = c.entity_id)
      end as entity_title
    from candidates c
  ), ins as (
    insert into notifications (agent_id, activity_id, kind, channel, status, body)
    select
      t.agent_id, t.activity_id, t.nkind, t.channel,
      case when t.channel is null then 'no_channel'::notification_status
           else 'pending'::notification_status end,
      -- Текст собирается здесь, чтобы отправщик остался простым и не лазил
      -- в данные сам.
      case t.nkind
        when 'overdue'  then 'Просрочено: '
        else 'Скоро срок: '
      end
      || case t.activity_kind when 'showing' then 'показ' else 'задача' end
      || coalesce(' по «' || t.entity_title || '»', '')
      || coalesce(E'\n' || t.body, '')
      || E'\nСрок: ' || to_char(t.due_at at time zone 'Asia/Bishkek', 'DD.MM.YYYY HH24:MI')
    from titled t
    -- Идемпотентность: повторный прогон расписания ничего не добавит.
    on conflict (activity_id, kind) do nothing
    returning notifications.kind
  )
  select i.kind, count(*)::integer from ins i group by i.kind;  -- в r_kind, r_enqueued
end $$;

comment on function app.enqueue_due_reminders is
  'Решает, о чём напомнить. Идемпотентна: повторный прогон не плодит дубликатов благодаря unique (activity_id, kind).';

-- ---------------------------------------------------------------------------
-- Выполнил или удалил — напоминать незачем
-- ---------------------------------------------------------------------------
-- Без этого агент получит напоминание о задаче, которую уже сделал: между
-- постановкой в очередь и отправкой проходит время.

create or replace function app.cancel_reminders_on_done() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.done and not old.done then
    update notifications
       set status = 'cancelled'
     where activity_id = new.id
       and status in ('pending', 'sending');
  end if;

  -- Срок сдвинули — прежние напоминания больше не про него.
  if new.due_at is distinct from old.due_at then
    delete from notifications
     where activity_id = new.id
       and status in ('pending', 'sending', 'no_channel');
  end if;

  return null;
end $$;

create trigger z_cancel_reminders
  after update of done, due_at on activities
  for each row execute function app.cancel_reminders_on_done();

-- ---------------------------------------------------------------------------
-- Отправщик берёт пачку и отчитывается
-- ---------------------------------------------------------------------------
-- Статус 'sending' ставится при выдаче: если расписание сработает дважды
-- одновременно, второй прогон этих строк уже не увидит.
--
-- Доступно только service_role: это работа фонового задания, не агента.

create or replace function app.claim_notifications(p_limit integer default 50)
  returns table (
    id uuid, agent_id uuid, channel notification_channel,
    body text, telegram_id bigint, attempts smallint
  )
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with picked as (
    select n.id from notifications n
     where n.status = 'pending'
       -- Три попытки: дальше молчим, чтобы не долбить мёртвый канал.
       and n.attempts < 3
     order by n.created_at
     limit p_limit
     for update skip locked
  )
  update notifications n
     set status = 'sending', attempts = n.attempts + 1
    from picked p, agents a
   where n.id = p.id and a.id = n.agent_id
  returning n.id, n.agent_id, n.channel, n.body, a.telegram_id, n.attempts;
end $$;

create or replace function app.mark_notification(
  p_id    uuid,
  p_ok    boolean,
  p_error text default null
) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications
     set status = case
                    when p_ok then 'sent'::notification_status
                    -- Исчерпал попытки — больше не берём.
                    when attempts >= 3 then 'failed'::notification_status
                    else 'pending'::notification_status
                  end,
         sent_at = case when p_ok then now() else sent_at end,
         last_error = case when p_ok then null else p_error end
   where id = p_id;
end $$;

grant usage on schema app to service_role;
grant execute on function
  app.enqueue_due_reminders(interval),
  app.claim_notifications(integer),
  app.mark_notification(uuid, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Привязка Telegram
-- ---------------------------------------------------------------------------
-- Агент не может привязать Telegram сам: колонка ему не выдана, а
-- самостоятельная привязка требует подтверждения через бота, которого здесь
-- нет. Пока это делает админ — он и так видит список агентов.

create or replace function set_agent_telegram(
  p_agent_id    uuid,
  p_telegram_id bigint
) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: привязать Telegram может только админ'
      using errcode = '42501';
  end if;

  update agents set telegram_id = p_telegram_id where id = p_agent_id
    returning * into r;

  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

grant execute on function set_agent_telegram(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Что агент видит про свои напоминания
-- ---------------------------------------------------------------------------

create or replace view my_reminders_v
  with (security_invoker = true) as
select
  n.id,
  n.activity_id,
  n.kind,
  n.channel,
  n.status,
  n.body,
  n.attempts,
  n.last_error,
  n.created_at,
  n.sent_at,
  a.due_at,
  a.kind as activity_kind
from notifications n
join activities a on a.id = n.activity_id;

grant select on my_reminders_v to authenticated;
revoke all   on my_reminders_v from anon;
