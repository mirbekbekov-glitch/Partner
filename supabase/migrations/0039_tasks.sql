-- 0039_tasks.sql
-- ИНВАРИАНТ 31: напоминание — это обещание, у которого есть срок, исполнитель
--               и предмет.
--
-- «Перезвонить клиенту» — главное действие агента и единственное, которого в
-- системе не было вовсе. Оно жило в голове, в блокноте и в переписке, то есть
-- нигде: забытый звонок ничем не отличается от сделанного.
--
-- ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Это не список дел и не заметки. Три вещи отличают
-- напоминание от стикера, и все три здесь — правила, а не поля:
--
--   СРОК. Задача без срока — это пожелание. `due_at` обязателен, и именно он
--   делает задачу просроченной, а не настроение агента.
--
--   ПРЕДМЕТ. Задача «позвонить» без того, кому звонить, бесполезна через
--   неделю. Предмет необязателен (бывает «съездить за ключами»), но если он
--   есть — он ОДИН: задача про клиента и про объект одновременно не найдётся
--   ни там, ни там.
--
--   ПОСЛЕДСТВИЕ. Напоминание уходит уведомлением — тем же механизмом, что
--   уведомления о показах (инвариант 27), а не вторым, похожим. Значит
--   бесплатно достаются его правила: один раз, тому, кому адресовано, и
--   только пока остаётся правдой. Перенёс срок — пришла поправка.
--
-- И ГЛАВНОЕ. Задача о закрытом предмете гаснет сама. Сделка сорвана, клиент
-- проигран, обращение закрыто — открытые задачи о них снимаются триггером.
-- Напоминание позвонить тому, кто уже купил, хуже, чем его отсутствие: оно
-- учит не читать напоминания.

create type task_kind as enum ('call', 'meeting', 'document', 'other');

comment on type task_kind is
  'Что это за дело. «Позвонить» первым и по умолчанию: это главное дело агента.';

create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  kind                task_kind   not null default 'call',
  title               text        not null,
  due_at              timestamptz not null,
  agent_id            uuid        not null references agents(id) on delete restrict,
  created_by_agent_id uuid        not null references agents(id) on delete restrict,

  -- Предмет: ни одного или ровно один.
  contact_id          uuid references contacts(id)     on delete cascade,
  requirement_id      uuid references requirements(id) on delete cascade,
  object_id           uuid references objects(id)      on delete cascade,
  deal_id             uuid references deals(id)        on delete cascade,
  inquiry_id          uuid references inquiries(id)    on delete cascade,

  done_at             timestamptz,
  done_note           text,
  cancelled_at        timestamptz,
  cancel_reason       text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint tasks_title_not_blank check (length(btrim(title)) > 0),
  constraint tasks_one_subject check (
    num_nonnulls(contact_id, requirement_id, object_id, deal_id, inquiry_id) <= 1),
  constraint tasks_one_outcome check (
    not (done_at is not null and cancelled_at is not null)),
  constraint tasks_cancel_has_reason check (
    (cancelled_at is null) = (cancel_reason is null))
);

comment on table tasks is
  'Инвариант 31. Дела и напоминания агента. Срок обязателен, предмет один, закрытая задача окончательна.';
comment on column tasks.due_at is
  'Когда это надо сделать. Обязателен: задача без срока — пожелание, и просроченной она не станет никогда.';
comment on column tasks.agent_id is
  'Исполнитель. Один: задача на двоих не сделана никем.';

create index tasks_agent_open_idx on tasks (agent_id, due_at)
  where done_at is null and cancelled_at is null;
create index tasks_contact_idx     on tasks (contact_id)     where contact_id     is not null;
create index tasks_requirement_idx on tasks (requirement_id) where requirement_id is not null;
create index tasks_object_idx      on tasks (object_id)      where object_id      is not null;
create index tasks_deal_idx        on tasks (deal_id)        where deal_id        is not null;
create index tasks_inquiry_idx     on tasks (inquiry_id)     where inquiry_id     is not null;

-- ---------------------------------------------------------------------------
-- Предмет задачи и его состояние
-- ---------------------------------------------------------------------------

create or replace function app.task_subject_closed(
  p_requirement_id uuid, p_deal_id uuid, p_inquiry_id uuid
) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select
       exists (select 1 from requirements r
                where r.id = p_requirement_id and r.status in ('closed', 'lost'))
    or exists (select 1 from deals d
                where d.id = p_deal_id and d.status in ('closed', 'failed'))
    or exists (select 1 from inquiries i
                where i.id = p_inquiry_id and i.status in ('converted', 'rejected', 'spam'))
$$;

comment on function app.task_subject_closed is
  'Инвариант 31. Предмет задачи завершён: клиент закрыт или проигран, сделка закрыта или сорвана, обращение разобрано.';

-- ---------------------------------------------------------------------------
-- Инвариант 31: правила задачи
-- ---------------------------------------------------------------------------

create or replace function app.check_task() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_me uuid;
begin
  new.title := btrim(new.title);

  -- Исполнитель — одобренный агент, а не любая строка в таблице агентов.
  if not exists (select 1 from agents a
                  where a.id = new.agent_id and a.status = 'approved') then
    raise exception 'INVARIANT_31: исполнитель задачи — одобренный агент'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.done_at is not null or new.cancelled_at is not null then
      raise exception 'INVARIANT_31: задача заводится открытой'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Закрытая задача окончательна. Передумали — заводится новая: иначе
  -- «сделано вчера» переписывается задним числом, и журнал звонков
  -- перестаёт быть журналом.
  if old.done_at is not null or old.cancelled_at is not null then
    raise exception 'INVARIANT_31: закрытая задача не меняется'
      using errcode = '42501',
            hint = 'Нужна ещё одна — заведите новую.';
  end if;

  -- Правит исполнитель, постановщик или администратор. Проверка в триггере,
  -- а не только в политике: функции задач security definer, и политика в них
  -- не работает (урок инвариантов 28 и 30).
  --
  -- Исключение одно и оно фактическое: задачу о закрытом предмете гасит сам
  -- предмет, и кто в этот момент нажал кнопку — неважно.
  v_me := app.current_agent_id();
  if auth.uid() is not null
     and not app.is_admin()
     and v_me is distinct from old.agent_id
     and v_me is distinct from old.created_by_agent_id
     and not (new.cancelled_at is not null
              and app.task_subject_closed(new.requirement_id, new.deal_id, new.inquiry_id))
  then
    raise exception 'INVARIANT_31: задачу ведёт её исполнитель или тот, кто её поставил'
      using errcode = '42501';
  end if;

  return new;
end $$;

create trigger b_task_rules
  before insert or update on tasks
  for each row execute function app.check_task();

create trigger a_touch_tasks
  before update on tasks
  for each row execute function app.touch_updated_at();

-- Имя сущности передаётся аргументом: без него app.write_audit() кладёт в
-- журнал NULL и падает на NOT NULL. Нашлось первой же пробой — и это ровно
-- та ошибка, ради которой пробуют на живой базе, а не рассуждают.
create trigger zz_audit_tasks
  after insert or update or delete on tasks
  for each row execute function app.write_audit('task', 'id');

-- ---------------------------------------------------------------------------
-- Инвариант 31: задача о закрытом предмете гаснет сама
-- ---------------------------------------------------------------------------
-- Последствие в триггере причины, а не в функциях закрытия: предмет
-- закрывают пятью путями, и правило обязано держаться на всех. Урок
-- инвариантов 21, 24, 25, 27 и 29.

create or replace function app.cancel_tasks_on_subject_close() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_col    text := tg_argv[0];
  v_final  text[] := tg_argv[1]::text[];
  v_reason text;
begin
  if not (new.status::text = any (v_final))
     or (old.status::text = any (v_final)) then
    return null;
  end if;

  v_reason := tg_table_name || ': ' || new.status::text;

  execute format(
    $f$update tasks
          set cancelled_at = now(),
              cancel_reason = %L
        where %I = %L
          and done_at is null
          and cancelled_at is null$f$,
    'предмет задачи завершён (' || v_reason || ')', v_col, new.id);

  return null;
end $$;

comment on function app.cancel_tasks_on_subject_close is
  'Инвариант 31. Клиент закрыт, сделка завершена, обращение разобрано — открытые задачи о них снимаются. Напоминание позвонить тому, кто уже купил, учит не читать напоминания.';

create trigger zy_tasks_follow_requirement
  after update of status on requirements
  for each row execute function app.cancel_tasks_on_subject_close(
    'requirement_id', '{closed,lost}');

create trigger zy_tasks_follow_deal
  after update of status on deals
  for each row execute function app.cancel_tasks_on_subject_close(
    'deal_id', '{closed,failed}');

create trigger zy_tasks_follow_inquiry
  after update of status on inquiries
  for each row execute function app.cancel_tasks_on_subject_close(
    'inquiry_id', '{converted,rejected,spam}');

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function create_task(
  p_title          text,
  p_due_at         timestamptz,
  p_kind           task_kind default 'call',
  p_agent_id       uuid default null,
  p_contact_id     uuid default null,
  p_requirement_id uuid default null,
  p_object_id      uuid default null,
  p_deal_id        uuid default null,
  p_inquiry_id     uuid default null
) returns tasks
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := app.require_agent();
  r    tasks;
begin
  insert into tasks (kind, title, due_at, agent_id, created_by_agent_id,
                     contact_id, requirement_id, object_id, deal_id, inquiry_id)
  values (p_kind, p_title, p_due_at, coalesce(p_agent_id, v_me), v_me,
          p_contact_id, p_requirement_id, p_object_id, p_deal_id, p_inquiry_id)
  returning * into r;
  return r;
end $$;

comment on function create_task is
  'Инвариант 31. Единственная дверь для заведения задачи. Без исполнителя — себе.';

create or replace function complete_task(p_task_id uuid, p_note text default null)
  returns tasks
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r tasks;
begin
  perform app.require_agent();
  update tasks
     set done_at = now(), done_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_task_id
  returning * into r;

  if r.id is null then
    raise exception 'задача % не найдена', p_task_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function cancel_task(p_task_id uuid, p_reason text)
  returns tasks
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r tasks;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'INVARIANT_31: у снятой задачи обязательна причина'
      using errcode = 'check_violation';
  end if;

  update tasks
     set cancelled_at = now(), cancel_reason = btrim(p_reason)
   where id = p_task_id
  returning * into r;

  if r.id is null then
    raise exception 'задача % не найдена', p_task_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function reschedule_task(p_task_id uuid, p_due_at timestamptz)
  returns tasks
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r tasks;
begin
  perform app.require_agent();
  update tasks set due_at = p_due_at where id = p_task_id returning * into r;

  if r.id is null then
    raise exception 'задача % не найдена', p_task_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function reschedule_task is
  'Инвариант 31. Перенос срока. Напоминание о старом сроке гаснет, о новом выпускается заново — это правило инварианта 27, и оно достаётся даром.';

-- ---------------------------------------------------------------------------
-- Что видно
-- ---------------------------------------------------------------------------

alter table tasks enable row level security;

create policy tasks_read on tasks for select
  using (agent_id = app.current_agent_id()
         or created_by_agent_id = app.current_agent_id()
         or app.is_admin());

create policy tasks_insert on tasks for insert
  with check (created_by_agent_id = app.current_agent_id() or app.is_admin());

create policy tasks_update on tasks for update
  using (agent_id = app.current_agent_id()
         or created_by_agent_id = app.current_agent_id()
         or app.is_admin());

create or replace view my_tasks_v
  with (security_invoker = true) as
select
  t.id,
  t.kind,
  t.title,
  t.due_at,
  t.agent_id,
  ag.full_name as agent_name,
  t.created_by_agent_id,
  t.done_at,
  t.done_note,
  t.cancelled_at,
  t.cancel_reason,
  case
    when t.done_at      is not null then 'сделано'
    when t.cancelled_at is not null then 'снято'
    when t.due_at < now()           then 'просрочено'
    else 'в работе'
  end as state,
  t.due_at < now() and t.done_at is null and t.cancelled_at is null as overdue,
  -- Предмет одной строкой: экрану нужно показать, о чём задача, а не
  -- разбирать пять столбцов.
  coalesce(c.name, rc.name, o.address, dc.name, i.contact_name) as subject_name,
  case
    when t.contact_id     is not null then 'contact'
    when t.requirement_id is not null then 'requirement'
    when t.object_id      is not null then 'object'
    when t.deal_id        is not null then 'deal'
    when t.inquiry_id     is not null then 'inquiry'
  end as subject_kind,
  t.contact_id, t.requirement_id, t.object_id, t.deal_id, t.inquiry_id,
  t.created_at
from tasks t
join agents ag          on ag.id = t.agent_id
left join contacts c    on c.id  = t.contact_id
left join requirements r on r.id = t.requirement_id
left join contacts rc   on rc.id = r.contact_id
left join objects o     on o.id  = t.object_id
left join deals d       on d.id  = t.deal_id
left join requirements dr on dr.id = d.requirement_id
left join contacts dc   on dc.id = dr.contact_id
left join inquiries i   on i.id  = t.inquiry_id;

comment on view my_tasks_v is
  'Инвариант 31. Задачи, видимые текущему агенту, с предметом одной строкой. Имя клиента показывается по правилам инварианта 4: его отдаёт политика контактов, а не это представление.';

create or replace view overdue_tasks_v
  with (security_invoker = true) as
select * from my_tasks_v where overdue;

comment on view overdue_tasks_v is
  'Инвариант 31. Просроченные обещания. Молчание о задаче не значит, что её сделали.';

-- ---------------------------------------------------------------------------
-- Инвариант 31 × инвариант 27: напоминание — это уведомление
-- ---------------------------------------------------------------------------
-- Очередь уведомлений не копируется, а расширяется предметом. Иначе рядом
-- появился бы второй механизм с теми же тремя ошибками — дважды, неправду и
-- не тому, — и чинить их пришлось бы заново.

alter type notification_kind add value 'task_due';
alter type notification_kind add value 'task_changed';

-- ---------------------------------------------------------------------------
-- Предмет уведомления
-- ---------------------------------------------------------------------------
-- До этой миграции уведомление всегда было о показе, и showing_id стоял
-- NOT NULL. Теперь предметов два, и ровно один из них обязателен: очередь
-- без предмета — это очередь строк, про которые нечего сказать.

alter table notifications alter column showing_id drop not null;
alter table notifications add column task_id uuid references tasks(id) on delete cascade;

alter table notifications add constraint notifications_one_subject check (
  num_nonnulls(showing_id, task_id) = 1);

comment on column notifications.task_id is
  'Задача, о которой напоминание (инвариант 31). Ровно один предмет: показ или задача.';

-- Ключ единственности для задач — ровно той же формы, что у показов, и с тем
-- же about_at. Это не копия ради симметрии: без времени в ключе перенос
-- срока оставлял бы систему молчащей после уже сказанного (урок инварианта
-- 27, самый дорогой в нём).
create unique index notifications_task_once_idx
  on notifications (kind, task_id, agent_id, about_at)
  where voided_at is null and task_id is not null;

create or replace function app.notify_lead(p_kind notification_kind)
  returns interval
  language sql immutable set search_path = pg_temp as $$
  select case p_kind
           -- Двадцать часов: вечерний показ попадает в утро того же дня,
           -- утренний — в вечер накануне. Не ночью и не за минуту.
           when 'showing_ahead' then interval '20 hours'
           -- Два часа: успеть собраться и доехать по Бишкеку.
           when 'showing_soon'  then interval '2 hours'
           -- Полчаса: напоминание «позвонить в 15:00» нужно не в 15:00, а
           -- пока ещё можно выйти из встречи и набрать номер.
           when 'task_due'      then interval '30 minutes'
           else interval '0'
         end
$$;

create or replace function app.task_notify_body(
  p_kind    notification_kind,
  p_task_id uuid
) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select t.title, t.kind, t.due_at, t.done_at, t.cancelled_at, t.cancel_reason,
         coalesce(c.name, rc.name, o.address, i.contact_name) as subject
    into r
    from tasks t
    left join contacts c      on c.id  = t.contact_id
    left join requirements rq on rq.id = t.requirement_id
    left join contacts rc     on rc.id = rq.contact_id
    left join objects o       on o.id  = t.object_id
    left join inquiries i     on i.id  = t.inquiry_id
   where t.id = p_task_id;

  if not found then
    return null;
  end if;

  if p_kind = 'task_changed' then
    return case
      when r.done_at      is not null then 'Задача закрыта: ' || r.title
      when r.cancelled_at is not null then 'Задача снята: ' || r.title ||
                                           ' — ' || coalesce(r.cancel_reason, 'без причины')
      else 'Задача перенесена на ' || app.at_bishkek(r.due_at) || ': ' || r.title
    end;
  end if;

  return case r.kind
           when 'call' then 'Позвонить'
           when 'meeting' then 'Встреча'
           when 'document' then 'Документы'
           else 'Дело'
         end
         || coalesce(' — ' || r.subject, '')
         || ': ' || r.title
         || ' (' || app.at_bishkek(r.due_at) || ')';
end $$;

comment on function app.task_notify_body is
  'Инвариант 31. Текст напоминания собирается в базе из задачи, а не приходит снаружи: иначе отправщик мог бы написать в нём что угодно и кому угодно.';

create or replace function app.enqueue_task_notification(
  p_kind     notification_kind,
  p_task_id  uuid,
  p_agent_id uuid,
  p_due_at   timestamptz
) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := app.task_notify_body(p_kind, p_task_id);
  v_at   timestamptz;
begin
  if v_body is null then
    return false;
  end if;

  -- Срок берётся из задачи, а не от вызывающего: напоминание обязано
  -- говорить о том, что в базе.
  select t.due_at into v_at from tasks t where t.id = p_task_id;

  insert into notifications (kind, task_id, agent_id, body, due_at, about_at)
  values (p_kind, p_task_id, p_agent_id, v_body, p_due_at, v_at)
  on conflict do nothing;

  return found;
end $$;

create or replace function app.produce_task_notifications() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select t.id, t.agent_id
      from tasks t
     where t.done_at is null
       and t.cancelled_at is null
       and t.due_at <= now() + app.notify_lead('task_due')
  loop
    if app.enqueue_task_notification('task_due', r.id, r.agent_id, now()) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

comment on function app.produce_task_notifications is
  'Инвариант 31. Выпуск напоминаний о задачах. Просроченные тоже попадают: обещание не перестаёт быть обещанием оттого, что срок прошёл.';

create or replace function app.job_produce_notifications() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'produced',       app.produce_notifications(),
    'produced_tasks', app.produce_task_notifications(),
    'released',       app.release_stale_notifications())
$$;

update maintenance_jobs
   set description = 'Выпуск уведомлений о показах и задачах и возврат в очередь зависших отправок'
 where job = 'produce_notifications';

-- ---------------------------------------------------------------------------
-- Инвариант 31 × 27: задача изменилась — напоминание тоже
-- ---------------------------------------------------------------------------

create or replace function app.void_task_notifications() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text;
  v_agent  uuid;
begin
  if new.due_at is not distinct from old.due_at
     and new.done_at is not distinct from old.done_at
     and new.cancelled_at is not distinct from old.cancelled_at
     and new.agent_id is not distinct from old.agent_id then
    return null;
  end if;

  v_reason := case
    when new.done_at      is not null then 'задача сделана'
    when new.cancelled_at is not null then 'задача снята: ' ||
                                           coalesce(new.cancel_reason, 'без причины')
    when new.agent_id is distinct from old.agent_id then 'задача передана другому агенту'
    else 'срок перенесён на ' || app.at_bishkek(new.due_at)
  end;

  update notifications
     set voided_at = now(), void_reason = v_reason
   where task_id = new.id
     and sent_at is null
     and voided_at is null;

  -- Кому уже сказали — тому говорят и поправку. Правило инварианта 27
  -- целиком, включая его оговорку: только тем, кому было что поправлять.
  for v_agent in
    select distinct n.agent_id
      from notifications n
     where n.task_id = new.id
       and n.sent_at is not null
  loop
    perform app.enqueue_task_notification('task_changed', new.id, v_agent, now());
  end loop;

  return null;
end $$;

create trigger zx_void_task_notifications
  after update on tasks
  for each row execute function app.void_task_notifications();

-- Представление уведомлений: показ теперь необязателен.
drop view if exists my_notifications_v;

create view my_notifications_v
  with (security_invoker = true) as
select
  n.id,
  n.kind,
  n.body,
  n.due_at,
  n.about_at,
  n.created_at,
  n.sent_at,
  n.voided_at,
  n.void_reason,
  n.attempts,
  n.last_error,
  case
    when n.voided_at is not null then 'погашено'
    when n.sent_at   is not null then 'отправлено'
    when n.last_error is not null then 'не ушло'
    else 'в очереди'
  end as state,
  s.id            as showing_id,
  s.scheduled_at,
  coalesce(s.scheduled_at, t.due_at) is distinct from n.about_at as moved_since,
  s.status        as showing_status,
  o.id            as object_id,
  coalesce(o.address, t.title) as address,
  n.task_id,
  t.title         as task_title,
  t.due_at        as task_due_at
from notifications n
left join showings s on s.id = n.showing_id
left join matches  m on m.id = s.match_id
left join objects  o on o.id = m.object_id
left join tasks    t on t.id = n.task_id;

comment on view my_notifications_v is
  'Уведомления, видимые агенту (политика таблицы). Предмет — показ или задача; «мне не пришло» должно иметь ответ в обоих случаях.';

grant select on my_notifications_v to authenticated;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, insert, update on tasks to authenticated;

revoke execute on function
  app.task_subject_closed(uuid, uuid, uuid),
  app.check_task(),
  app.cancel_tasks_on_subject_close(),
  app.task_notify_body(notification_kind, uuid),
  app.enqueue_task_notification(notification_kind, uuid, uuid, timestamptz),
  app.produce_task_notifications(),
  app.void_task_notifications(),
  create_task(text, timestamptz, task_kind, uuid, uuid, uuid, uuid, uuid, uuid),
  complete_task(uuid, text),
  cancel_task(uuid, text),
  reschedule_task(uuid, timestamptz)
  from public;

grant execute on function
  create_task(text, timestamptz, task_kind, uuid, uuid, uuid, uuid, uuid, uuid),
  complete_task(uuid, text),
  cancel_task(uuid, text),
  reschedule_task(uuid, timestamptz)
  to authenticated;

grant select on my_tasks_v, overdue_tasks_v to authenticated;
revoke all on my_tasks_v, overdue_tasks_v, tasks from anon;
