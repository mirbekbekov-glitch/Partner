-- 0033_notifications.sql
-- ИНВАРИАНТ 27: уведомление уходит один раз, тому, кому адресовано, и только
--               пока остаётся правдой.
--
-- Экраны показов и календарь показывают всё, что нужно, — но только тому, кто
-- на них смотрит. Агент в машине не смотрит. Поэтому уведомления: завтрашний
-- показ, показ через два часа, показ без исхода и две группы у одной двери.
--
-- Уведомления — это место, где системы обычно врут трижды.
--
--   1. ДВАЖДЫ. Задача по расписанию выбирает «показы в ближайшие сутки» и
--      отправляет. Через пятнадцать минут она выбирает их снова. Агент
--      получает одно и то же письмо до самого показа. Лечится не памятью в
--      коде отправщика, а ключом в базе: пара «повод + показ + получатель»
--      существует в одном экземпляре, и повторная выдача ничего не создаёт.
--
--   2. НЕПРАВДУ. Уведомление поставлено в очередь вечером, ночью показ
--      отменили — утром оно уходит, и агент едет к запертой двери. Очередь
--      обязана слушать предмет: показ перестал быть назначенным — висящие
--      уведомления о нём гаснут. Это снова урок инвариантов 21, 24 и 25:
--      последствие живёт в триггере причины, а не в функции.
--
--      Перенос — тот же случай, но с продолжением: уведомление о старом
--      времени гаснет, а о новом должно появиться. Поэтому ключ единственности
--      частичный — погашенное место не занимает.
--
--   3. НЕ ТОМУ. В тексте уведомления стоят адрес и имя клиента. Отправить его
--      агенту, который к показу не причастен, значит отдать чужого клиента —
--      инвариант 4, только другим путём. Получатель вычисляется в базе из
--      показа, а не передаётся вызывающим.
--
-- Отправка живёт снаружи: сеть в транзакции — худшее, что можно сделать с
-- базой. Поэтому у очереди три действия: взять пачку, отметить отправленным,
-- отметить неудачей. Взятие помечает строку, как взятие кандидата в
-- инварианте 12: если отправщик умрёт между взятием и отметкой, уведомление
-- не потеряется — его вернёт в очередь обслуживание.
--
-- Отправщик ходит под своей ролью `notifier`, как служба входа под
-- `auth_service` (инвариант 18): ему открыты три функции и ни одной таблицы.
-- Процесс, который умеет только отправлять, при утечке токена и может только
-- отправлять — он не прочитает ни клиентов, ни сделок.

-- ---------------------------------------------------------------------------
-- Поводы
-- ---------------------------------------------------------------------------

create type notification_kind as enum (
  'showing_ahead',      -- показ скоро: сегодня вечером или завтра
  'showing_soon',       -- показ через пару часов
  'showing_overdue',    -- время прошло, исхода нет
  'showing_clash',      -- в этот час объект показывает ещё один агент
  'showing_changed'     -- то, о чём уже сообщили, изменилось
);

comment on type notification_kind is
  'Повод уведомления. Новый повод — это миграция, а не строка в таблице: вместе с поводом пишется и текст, и правило, кому он адресован.';

-- ---------------------------------------------------------------------------
-- Очередь
-- ---------------------------------------------------------------------------

create table notifications (
  id            uuid primary key default gen_random_uuid(),

  kind          notification_kind not null,
  -- Предмет уведомления. Сейчас это всегда показ, и внешний ключ поставлен
  -- именно на показы: уведомление о том, чего нет, не должно существовать, а
  -- «универсальный subject_id без ссылки» — это способ однажды разойтись.
  showing_id    uuid not null references showings (id) on delete cascade,

  -- Получатель. Вычисляется из показа функциями ниже, а не приходит снаружи.
  agent_id      uuid not null references agents (id) on delete cascade,

  -- Текст складывается в базе: он один и тот же для всех каналов, и ему место
  -- рядом с правилом, а не в трёх отправщиках.
  body          text not null check (length(btrim(body)) > 0),

  -- Когда уведомление имеет смысл отправить. Раньше — рано, позже — поздно.
  due_at        timestamptz not null,

  -- О КАКОМ времени показа оно говорит. Не украшение и не копия: именно это
  -- поле делает уведомление устаревающим. Показ перенесли — прежнее
  -- уведомление говорит о прежнем времени и больше не занимает места.
  about_at      timestamptz not null,

  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz,
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text,

  -- Погашено: предмет перестал быть правдой. Не удаляем — журнал инварианта 7
  -- и без того всё помнит, но видеть «готовилось и отменилось» полезно и в
  -- самой очереди.
  voided_at     timestamptz,
  void_reason   text,

  constraint notifications_void_has_reason
    check (voided_at is null or length(btrim(coalesce(void_reason, ''))) > 0),
  -- Отправленное не гасится и наоборот: два взаимоисключающих исхода.
  constraint notifications_one_outcome
    check (sent_at is null or voided_at is null)
);

-- ЭТО И ЕСТЬ «ОДИН РАЗ». Не счётчик, не память отправщика, не «проверим перед
-- вставкой» — ограничение.
--
-- В ключе стоит about_at, и это исправление настоящей дыры. Сначала ключ был
-- без него, а частичность индекса (погашенные не в счёт) казалась достаточной.
-- Не была: ОТПРАВЛЕННОЕ уведомление гасить нельзя — оно ушло, — и оно держало
-- место вечно. Показ переносили с 11:00 на 17:00, агенту было сказано «завтра
-- в 11:00», нового уведомления выпустить было уже нельзя, и поправка не
-- приходила никогда. Система не промолчала — она соврала и замолчала.
--
-- С about_at место держит не «уведомление об этом показе», а «уведомление об
-- ЭТОМ ВРЕМЕНИ этого показа». Перенос — другое время, другое место в ключе.
create unique index notifications_once_idx
  on notifications (kind, showing_id, agent_id, about_at)
  where voided_at is null;

comment on index notifications_once_idx is
  'Инвариант 27. Один повод по одному времени одного показа одному агенту — один раз. about_at в ключе: перенесённый показ это другое время, и о нём нужно сказать заново.';

create index notifications_due_idx on notifications (due_at)
  where sent_at is null and voided_at is null;
create index notifications_agent_idx on notifications (agent_id, created_at desc);

comment on table notifications is
  'Инвариант 27. Очередь уведомлений. Отправка снаружи: взять, отправить, отметить.';

create trigger zz_audit_notifications
  after insert or update or delete on notifications
  for each row execute function app.write_audit('notification', 'id');

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------
-- Своё уведомление агент видит, чужое — нет: в нём имя клиента и адрес.
-- Писать в очередь руками нельзя вовсе — её наполняет расписание.

alter table notifications enable row level security;

create policy notifications_read on notifications for select
  using (agent_id = app.current_agent_id() or app.is_admin());

grant select on notifications to authenticated;
revoke insert, update, delete on notifications from authenticated;
revoke all on notifications from anon;

-- ---------------------------------------------------------------------------
-- Сроки
-- ---------------------------------------------------------------------------

create or replace function app.notify_lead(p_kind notification_kind)
  returns interval
  language sql immutable set search_path = pg_temp as $$
  select case p_kind
           -- Двадцать часов: вечерний показ попадает в утро того же дня,
           -- утренний — в вечер накануне. Не ночью и не за минуту.
           when 'showing_ahead' then interval '20 hours'
           -- Два часа: успеть собраться и доехать по Бишкеку.
           when 'showing_soon'     then interval '2 hours'
           else interval '0'
         end
$$;

comment on function app.notify_lead is
  'За сколько до показа повод становится уместным.';

create or replace function app.notify_claim_ttl() returns interval
  language sql immutable set search_path = pg_temp as $$
  select interval '10 minutes'
$$;

comment on function app.notify_claim_ttl is
  'Сколько уведомление ждёт отметки после взятия. Дольше — отправщик считается умершим, и уведомление возвращается в очередь.';

-- ---------------------------------------------------------------------------
-- Текст
-- ---------------------------------------------------------------------------
-- Складывается в базе: один текст на все каналы, рядом с правилом. Телефона
-- в нём нет и быть не может — инвариант 4 не отменяется тем, что сообщение
-- уходит участнику показа.

create or replace function app.day_word(p_at timestamptz) returns text
  language sql stable set search_path = pg_temp as $$
  select case (p_at at time zone 'Asia/Bishkek')::date
              - (now() at time zone 'Asia/Bishkek')::date
           when 0 then 'сегодня'
           when 1 then 'завтра'
           when -1 then 'вчера'
           else to_char(p_at at time zone 'Asia/Bishkek', 'DD.MM')
         end || to_char(p_at at time zone 'Asia/Bishkek', ' в HH24:MI')
$$;

comment on function app.day_word is
  'День и час по Бишкеку человеческими словами. Первая версия уведомления писала «Завтра в 17:00» о сегодняшнем показе: повод назывался showing_tomorrow, и слово приехало из названия повода, а не из календаря.';

create or replace function app.notify_body(
  p_kind notification_kind,
  p_showing_id uuid
) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r        record;
  v_status text;
begin
  select s.scheduled_at, o.address, c.name as client_name, ag.full_name as agent_name
    into r
    from showings s
    join matches m   on m.id = s.match_id
    join objects o   on o.id = m.object_id
    join requirements rq on rq.id = m.requirement_id
    left join contacts c on c.id = rq.contact_id
    left join agents ag  on ag.id = s.agent_id
   where s.id = p_showing_id;

  if not found then
    return null;
  end if;

  if p_kind = 'showing_changed' then
    -- Поправка к тому, что уже сказано. Что именно изменилось, функция
    -- читает из показа: триггер срабатывает после записи, и строка уже новая.
    select s.status::text into v_status from showings s where s.id = p_showing_id;
    return case
      when v_status = 'scheduled' then
        format('Показ по адресу %s перенесён на %s. Прежнее время больше не в силе.',
               r.address, app.at_bishkek(r.scheduled_at))
      when v_status = 'cancelled' then
        format('Показ %s (%s) отменён. Ехать не нужно.',
               app.at_bishkek(r.scheduled_at), r.address)
      when v_status = 'no_show' then
        format('Показ %s (%s) отмечен как несостоявшийся: клиент не пришёл.',
               app.at_bishkek(r.scheduled_at), r.address)
      else
        format('Показ %s (%s) закрыт: %s.',
               app.at_bishkek(r.scheduled_at), r.address, v_status)
    end;
  end if;

  return case p_kind
    when 'showing_ahead' then
      format('Показ %s: %s, клиент %s.',
             app.day_word(r.scheduled_at),
             r.address, coalesce(r.client_name, 'без имени'))
    when 'showing_soon' then
      format('Через два часа показ, в %s: %s, клиент %s.',
             to_char(r.scheduled_at at time zone 'Asia/Bishkek', 'HH24:MI'),
             r.address, coalesce(r.client_name, 'без имени'))
    when 'showing_overdue' then
      format('Показ %s (%s) прошёл, а исход не записан. Собственник ждёт ответа, клиент тоже.',
             app.at_bishkek(r.scheduled_at), r.address)
    when 'showing_clash' then
      format('%s, %s: в этот час объект показывает ещё один агент. У двери окажутся две группы.',
             app.at_bishkek(r.scheduled_at), r.address)
  end;
end $$;

comment on function app.notify_body is
  'Текст уведомления. Телефона в нём нет: инвариант 4 не отменяется тем, что сообщение уходит участнику показа.';

-- ---------------------------------------------------------------------------
-- Выпуск: кто и о чём
-- ---------------------------------------------------------------------------
-- Получатель вычисляется из показа. Для первых трёх поводов это тот, кто
-- показ проводит: он и едет. Для столкновения — оба агента: узнать о второй
-- группе должны оба, иначе договариваться будет некому.

create or replace function app.enqueue_notification(
  p_kind       notification_kind,
  p_showing_id uuid,
  p_agent_id   uuid,
  p_due_at     timestamptz
) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := app.notify_body(p_kind, p_showing_id);
  v_at   timestamptz;
begin
  if v_body is null then
    return false;
  end if;

  -- Время берётся из показа, а не от вызывающего: уведомление должно
  -- говорить о том, что в базе, а не о том, что помнит код.
  select s.scheduled_at into v_at from showings s where s.id = p_showing_id;

  insert into notifications (kind, showing_id, agent_id, body, due_at, about_at)
  values (p_kind, p_showing_id, p_agent_id, v_body, p_due_at, v_at)
  -- Ключ единственности — частичный, поэтому on conflict нужен с его же
  -- условием: иначе повторный выпуск падал бы, а не молчал.
  on conflict (kind, showing_id, agent_id, about_at) where voided_at is null
  do nothing;

  return found;
end $$;

comment on function app.enqueue_notification is
  'Инвариант 27. Поставить уведомление в очередь. Повторный вызов ничего не создаёт — это ограничение базы, а не проверка вызывающего.';

create or replace function app.produce_notifications() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r       record;
  v_count integer := 0;
begin
  -- Завтрашний показ и показ через два часа: повод появляется, когда до
  -- показа остаётся меньше его срока. Уже прошедшие не берём.
  for r in
    select s.id, s.agent_id, s.scheduled_at, k.kind
      from showings s
      cross join (values ('showing_ahead'::notification_kind),
                         ('showing_soon'::notification_kind)) as k(kind)
     where s.status = 'scheduled'
       and s.scheduled_at > now()
       and s.scheduled_at <= now() + app.notify_lead(k.kind)
  loop
    if app.enqueue_notification(r.kind, r.id, r.agent_id, now()) then
      v_count := v_count + 1;
    end if;
  end loop;

  -- Показ без исхода. Тот же отбор, что у overdue_showings_v, но взятый
  -- напрямую: представление отдаёт только то, что видно читающему, а
  -- расписание читает за всех.
  for r in
    select s.id, s.agent_id
      from showings s
     where s.status = 'scheduled'
       and s.scheduled_at < now() - app.showing_slot()
  loop
    if app.enqueue_notification('showing_overdue', r.id, r.agent_id, now()) then
      v_count := v_count + 1;
    end if;
  end loop;

  -- Две группы у одной двери. Уведомляются оба агента: каждая сторона видит
  -- свой показ в своей очереди.
  for r in
    select s.id, s.agent_id
      from showings s
      join matches m  on m.id = s.match_id
      join matches om on om.object_id = m.object_id
      join showings other
        on other.match_id = om.id
       and other.id <> s.id
       and other.status = 'scheduled'
       and other.agent_id <> s.agent_id
       and other.scheduled_at < s.scheduled_at + app.showing_slot()
       and s.scheduled_at < other.scheduled_at + app.showing_slot()
     where s.status = 'scheduled'
       and s.scheduled_at > now()
     group by s.id, s.agent_id
  loop
    if app.enqueue_notification('showing_clash', r.id, r.agent_id, now()) then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $$;

comment on function app.produce_notifications is
  'Инвариант 27. Выпускает уведомления по текущему состоянию показов. Идемпотентна: повторный запуск ничего не добавляет.';

-- ---------------------------------------------------------------------------
-- Инвариант 27: уведомление гаснет вместе с поводом
-- ---------------------------------------------------------------------------
-- Последствие в триггере, а не в функции: показ снимают четырьмя путями
-- (функцией, каскадом инварианта 25, обслуживанием, прямой правкой), и
-- правило обязано держаться на всех.

create or replace function app.void_notifications() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text;
  v_agent  uuid;
begin
  if new.status = 'scheduled' and old.status = 'scheduled'
     and new.scheduled_at is not distinct from old.scheduled_at then
    return null;
  end if;

  v_reason := case
    when new.status <> 'scheduled' then 'показ больше не назначен: ' || new.status::text
    else 'показ перенесён на ' || app.at_bishkek(new.scheduled_at)
  end;

  update notifications
     set voided_at = now(), void_reason = v_reason
   where showing_id = new.id
     and sent_at is null
     and voided_at is null;

  -- Отправленное назад не вернёшь — но раз агенту уже сказали, ему должны
  -- сказать и то, что это изменилось. Поправка уходит ТОЛЬКО тем, кому было
  -- что поправлять: уведомление об отмене показа, о котором человек не знал,
  -- это шум, а шум в уведомлениях учит их не читать.
  for v_agent in
    select distinct n.agent_id
      from notifications n
     where n.showing_id = new.id
       and n.sent_at is not null
       and n.kind <> 'showing_changed'
  loop
    perform app.enqueue_notification('showing_changed', new.id, v_agent, now());
  end loop;

  return null;
end $$;

comment on function app.void_notifications is
  'Инвариант 27. Показ отменён, не состоялся, закрыт или перенесён: неотправленные уведомления о нём гаснут, а тем, кому уже сказали, уходит поправка. Отправленное не трогаем — переписать прошлое нельзя, но промолчать после сказанного нельзя тем более.';

create trigger zx_void_notifications
  after update on showings
  for each row execute function app.void_notifications();

-- ---------------------------------------------------------------------------
-- Очередь наружу: взять, отметить
-- ---------------------------------------------------------------------------

create or replace function app.take_notifications(p_limit integer default 20)
  returns table (id uuid, kind notification_kind, agent_id uuid,
                 telegram_id bigint, phone text, body text)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with ready as (
    select n.id
      from notifications n
     where n.sent_at is null
       and n.voided_at is null
       and n.due_at <= now()
       and (n.claimed_at is null or n.claimed_at < now() - app.notify_claim_ttl())
     order by n.due_at
     limit greatest(p_limit, 0)
     -- Две копии отправщика не должны взять одно уведомление: блокировка
     -- строк здесь дешевле, чем разбираться потом, почему агенту пришло два.
     for update of n skip locked
  ), taken as (
    update notifications n
       set claimed_at = now(), attempts = n.attempts + 1
      from ready
     where n.id = ready.id
    returning n.id, n.kind, n.agent_id, n.body
  )
  select t.id, t.kind, t.agent_id, a.telegram_id, a.phone, t.body
    from taken t
    join agents a on a.id = t.agent_id;
end $$;

comment on function app.take_notifications is
  'Инвариант 27. Взять пачку на отправку. Счётчик попыток растёт при взятии, а не при неудаче: процесс, умерший на середине, иначе не оставил бы следа.';

create or replace function app.mark_notification_sent(p_id uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications
     set sent_at = now(), last_error = null
   where id = p_id and sent_at is null and voided_at is null;
  return found;
end $$;

create or replace function app.mark_notification_failed(p_id uuid, p_error text)
  returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Отметка неудачи — это ЗАПИСЬ, а не исключение. Урок инварианта 18: то,
  -- что обязано пережить неудачу, нельзя сообщать исключением — оно откатит
  -- собственную запись вместе с транзакцией.
  update notifications
     set claimed_at = null,
         last_error = left(coalesce(p_error, 'без объяснения'), 500)
   where id = p_id and sent_at is null and voided_at is null;
  return found;
end $$;

comment on function app.mark_notification_failed is
  'Неудача отправки записывается, а не выбрасывается: исключение откатило бы собственную запись. Взятие снимается, уведомление возвращается в очередь.';

create or replace function app.release_stale_notifications() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  with released as (
    update notifications
       set claimed_at = null
     where sent_at is null and voided_at is null
       and claimed_at is not null
       and claimed_at < now() - app.notify_claim_ttl()
    returning 1
  ) select count(*) into v_count from released;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Расписание
-- ---------------------------------------------------------------------------

create or replace function app.job_produce_notifications() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'produced', app.produce_notifications(),
    'released', app.release_stale_notifications())
$$;

insert into maintenance_jobs (job, description, cron_expression, max_silence, handler)
values (
  'produce_notifications',
  'Выпуск уведомлений о показах и возврат в очередь зависших отправок',
  '13 * * * *',
  interval '3 hours',
  'app.job_produce_notifications()'::regprocedure);

-- ---------------------------------------------------------------------------
-- Что видит агент
-- ---------------------------------------------------------------------------

create or replace view my_notifications_v
  with (security_invoker = true) as
select
  n.id,
  n.kind,
  n.body,
  n.due_at,
  -- О каком времени показа уведомление говорит. На экране это важнее
  -- текущего времени показа: сообщение «показ сегодня в 11:00» под строкой
  -- «показ в 19:30» противоречит само себе, а разница объясняет перенос.
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
  s.scheduled_at is distinct from n.about_at as moved_since,
  s.status        as showing_status,
  o.id            as object_id,
  o.address
from notifications n
join showings s on s.id = n.showing_id
join matches  m on m.id = s.match_id
join objects  o on o.id = m.object_id;

comment on view my_notifications_v is
  'Уведомления, видимые агенту (политика таблицы). Очередь видна ему самому: «мне не пришло» должно иметь ответ.';

-- ---------------------------------------------------------------------------
-- Роль отправщика
-- ---------------------------------------------------------------------------
-- Как служба входа в инварианте 18: три функции и ни одной таблицы. Процесс,
-- умеющий только отправлять, при утечке токена и может только отправлять.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'notifier') then
    create role notifier nologin;
  end if;
end $$;

grant usage on schema app to notifier;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.day_word(timestamptz),
  app.notify_lead(notification_kind),
  app.notify_claim_ttl(),
  app.notify_body(notification_kind, uuid),
  app.enqueue_notification(notification_kind, uuid, uuid, timestamptz),
  app.produce_notifications(),
  app.void_notifications(),
  app.take_notifications(integer),
  app.mark_notification_sent(uuid),
  app.mark_notification_failed(uuid, text),
  app.release_stale_notifications(),
  app.job_produce_notifications()
  from public;

grant execute on function
  app.take_notifications(integer),
  app.mark_notification_sent(uuid),
  app.mark_notification_failed(uuid, text)
  to notifier;

grant select on my_notifications_v to authenticated;
revoke all on my_notifications_v from anon, notifier;
