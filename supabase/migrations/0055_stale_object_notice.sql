-- 0055_stale_object_notice.sql
-- Объект давно не подтверждали — агент узнаёт об этом сам, без захода в отчёт.
-- Пункт P0.7 спецификации, решение владельца продукта.
--
-- РЕШЕНИЕ: ПРЕДУПРЕЖДАТЬ, НЕ СНИМАТЬ.
--
-- Автоснятие при ПРОСРОЧЕННОМ ДОГОВОРЕ уже работает и этой миграции не
-- касается: app.expire_mandates() ночью переводит мандат в «истёк», а
-- триггер app.withdraw_on_mandate_release() убирает объект из каталога и
-- помечает выгрузки снятыми. Основание там юридическое — договора нет,
-- показывать объявление не на чем.
--
-- Здесь другой случай: договор в силе, а подтверждения давно не было. Это
-- организационная оплошность, а не потеря права. Владелец продукта выбрал
-- предупреждать и не снимать, и доводы за этот выбор такие: снятие рвёт
-- ссылки, уже разосланные клиентам, и наказывает агента в отпуске за то, что
-- объект, возможно, жив. Цена выбора названа прямо: каталог остаётся честным
-- ровно настолько, насколько агенты отзываются на предупреждение.
--
-- ОДНО УВЕДОМЛЕНИЕ НА ОДНО ПРОТУХАНИЕ, а не каждую ночь.
--
-- Повод привязывается к тому самому подтверждению, которое протухло:
-- about_at = objects.actual_at. Пока агент не подтвердил, это одна и та же
-- дата, и частичный уникальный ключ не даёт выпустить второе уведомление.
-- Подтвердил — actual_at сдвинулся, и следующее протухание будет новым
-- поводом. Это та же конструкция, что у показов (about_at = scheduled_at) и
-- у задач (about_at = due_at), а не третья своя.
--
-- И НЕ УЙДЁТ ТО, ЧТО УЖЕ НЕПРАВДА. Неотправленное уведомление гасится, как
-- только объект подтвердили или он ушёл из каталога: письмо «объект не
-- подтверждали 14 дней», пришедшее через час после подтверждения, хуже
-- молчания — оно учит не верить уведомлениям.

-- ---------------------------------------------------------------------------
-- Вид уведомления
-- ---------------------------------------------------------------------------
-- Отдельным оператором: значение перечисления нельзя добавить и использовать
-- в одной транзакции («unsafe use of new value»). Файл применяется psql'ом
-- по операторам, а на размещённой базе — запасным пооператорным путём
-- db/push-hosted.mjs, заведённым ровно из-за этого (миграция 0039).
alter type notification_kind add value if not exists 'object_stale';

-- ---------------------------------------------------------------------------
-- Уведомление об объекте
-- ---------------------------------------------------------------------------
-- Колонка рядом с showing_id и task_id: у очереди уже два вида поводов, это
-- третий. Складывать объект в showing_id «потому что похоже» значило бы
-- соврать в типе ради экономии одной колонки.

alter table notifications
  add column object_id uuid references objects(id) on delete cascade;

comment on column notifications.object_id is
  'Объект, о котором уведомление. Ровно один предмет: показ, задача или объект.';

-- Предмет по-прежнему РОВНО ОДИН, их стало трое.
--
-- Ограничение пришлось переписать, и хорошо, что оно было: первая версия
-- этой миграции добавила колонку и не тронула проверку, а база отказалась
-- принимать уведомление об объекте — «violates check constraint
-- notifications_one_subject». Очередь без предмета это строки, про которые
-- нечего сказать; очередь с двумя предметами — строки, про которые нельзя
-- сказать, о чём они.
alter table notifications drop constraint notifications_one_subject;
alter table notifications add constraint notifications_one_subject check (
  num_nonnulls(showing_id, task_id, object_id) = 1);

-- Ключ единственности частичный, как у показов и задач: гасить и выпускать
-- заново должно быть можно, поэтому погашенные из-под ключа выходят.
create unique index notifications_object_once_idx
  on notifications (kind, object_id, agent_id, about_at)
  where voided_at is null and object_id is not null;

-- ---------------------------------------------------------------------------
-- Текст
-- ---------------------------------------------------------------------------
-- Текст собирается в базе, как у показов и задач: уведомление обязано
-- говорить то, что в базе, а не то, что помнит вызывающий код.
--
-- В тексте названы три вещи, и каждая отвечает на вопрос агента: какой
-- объект, сколько дней молчания и что сделать. Без последнего уведомление
-- сообщает о беде и оставляет с ней наедине.

create or replace function app.object_notify_body(
  p_kind notification_kind, p_object_id uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select o.address, o.publication_state,
         current_date - o.actual_at::date as days
    into r
    from objects o
   where o.id = p_object_id;

  if not found then
    return null;
  end if;

  if p_kind = 'object_stale' then
    return 'Объект не подтверждали ' || r.days || ' дн.: ' || r.address
        || '. Подтвердите актуальность или снимите с каталога.';
  end if;

  return null;
end $$;

comment on function app.object_notify_body is
  'Текст уведомления об объекте. Собирается в базе: уведомление говорит то, что в базе, а не то, что помнит вызывающий код.';

create or replace function app.enqueue_object_notification(
  p_kind notification_kind, p_object_id uuid, p_agent_id uuid,
  p_due_at timestamptz) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := app.object_notify_body(p_kind, p_object_id);
  v_at   timestamptz;
begin
  if v_body is null then
    return false;
  end if;

  -- Повод — ТО САМОЕ подтверждение, которое протухло. Пока агент не
  -- подтвердил, это одна и та же дата, и ключ единственности не даёт
  -- выпустить второе уведомление ни на следующую ночь, ни через месяц.
  select o.actual_at into v_at from objects o where o.id = p_object_id;

  insert into notifications (kind, object_id, agent_id, body, due_at, about_at)
  values (p_kind, p_object_id, p_agent_id, v_body, p_due_at, v_at)
  on conflict do nothing;

  return found;
end $$;

comment on function app.enqueue_object_notification is
  'Ставит в очередь уведомление об объекте. Повод — то самое подтверждение, которое протухло: пока его не обновили, второго уведомления не будет.';


-- ---------------------------------------------------------------------------
-- Выпуск
-- ---------------------------------------------------------------------------
-- Тело взято из базы дословно, добавлен один цикл в конце.

CREATE OR REPLACE FUNCTION app.produce_notifications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Объект давно не подтверждали. Отбор тот же, что у stale_objects_v в
  -- признаке needs_confirmation, но взятый напрямую: представление отдаёт
  -- только то, что видно читающему, а расписание читает за всех.
  --
  -- Адресат — listing-агент действующего договора. Не всё агентство: объект
  -- ведёт он, кнопки подтверждения есть у него, и рассылать беспокойство
  -- тем, кто ничего не может сделать, значит учить не читать уведомления.
  for r in
    select o.id, m.listing_agent_id as agent_id
      from objects o
      join mandates m on m.object_id = o.id and m.status = 'active'
     where o.publication_state = 'published'
       and current_date - o.actual_at::date > app.stale_after_days()
  loop
    if app.enqueue_object_notification('object_stale', r.id, r.agent_id, now()) then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $function$;

comment on function app.produce_notifications is
  'Выпуск уведомлений: показы, накладки и объекты, которые давно не подтверждали. Отбор берётся напрямую, а не через представления: представление отдаёт то, что видно читающему, а расписание читает за всех.';

revoke execute on function
  app.object_notify_body(notification_kind, uuid),
  app.enqueue_object_notification(notification_kind, uuid, uuid, timestamptz)
  from public;

-- ---------------------------------------------------------------------------
-- Гашение
-- ---------------------------------------------------------------------------
-- Неотправленное уведомление снимается, как только его повод перестал быть
-- правдой: объект подтвердили или он ушёл из каталога.
--
-- Это не вежливость. Письмо «объект не подтверждали 14 дней», пришедшее
-- через час после подтверждения, — неправда, сказанная нашим голосом. Одного
-- такого хватает, чтобы агент перестал читать уведомления вообще, и тогда
-- бесполезны станут и те, что про показы.
--
-- Образец — app.void_notifications() на показах: там уведомление гасится,
-- когда показ перенесли или отменили. Здесь то же самое и по той же причине.

create or replace function app.void_object_notifications() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text;
begin
  if new.actual_at is not distinct from old.actual_at
     and new.publication_state is not distinct from old.publication_state then
    return null;
  end if;

  v_reason := case
    when new.publication_state <> 'published' then
      'объект больше не в каталоге: ' || new.publication_state::text
    else 'объект подтверждён ' || app.at_bishkek(new.actual_at)
  end;

  update notifications
     set voided_at = now(), void_reason = v_reason
   where object_id = new.id
     and kind = 'object_stale'
     and sent_at is null
     and voided_at is null;

  return null;
end $$;

comment on function app.void_object_notifications is
  'Снимает неотправленные уведомления об объекте, когда их повод перестал быть правдой: объект подтвердили или сняли с каталога.';

revoke execute on function app.void_object_notifications() from public;

create trigger zy_void_object_notifications
  after update on objects
  for each row execute function app.void_object_notifications();

-- ---------------------------------------------------------------------------
-- Экран уведомлений
-- ---------------------------------------------------------------------------
-- Представление выводило объект ТОЛЬКО через показ: уведомление → показ →
-- подбор → объект. У уведомления об объекте показа нет, и на экране оно
-- осталось бы строкой без адреса — то есть «что-то случилось, догадайтесь
-- где». Теперь объект берётся и напрямую.
--
-- moved_since («повод с тех пор изменился») для объекта считается по
-- actual_at: повод уведомления — то самое подтверждение, и если оно уже
-- другое, строка на экране обязана это показать.
--
-- SECURITY INVOKER, И ЭТО ОТДЕЛЬНАЯ ПОЧИНКА.
--
-- Представление не было помечено `security_invoker`, то есть читалось
-- правами владельца и ОБХОДИЛО политику таблицы notifications. Любой
-- одобренный агент видел через него уведомления всех остальных — с именами
-- чужих клиентов и адресами чужих показов. Через саму таблицу он при этом
-- видел ноль строк: политика работала, её просто обходили сверху.
--
-- Дефект не из этой миграции, он с 0039. Нашёлся потому, что проверка
-- «тому, кому адресовано» впервые пошла ТЕМ ЖЕ путём, что кабинет, — через
-- представление, а не через таблицу. Шапка инварианта 27 обещала это с
-- самого начала; проверено не было.
--
-- Соседи просмотрены: без `security_invoker` остаются public_catalog_v,
-- public_photo_v (они и должны читаться правами владельца — каталог открыт
-- анониму) и channel_feeds_v (настройки выгрузки агентства, не чужая
-- работа). Больше таких нет.

create or replace view my_notifications_v with (security_invoker = true) as
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
  coalesce(s.scheduled_at, t.due_at, ob.actual_at) is distinct from n.about_at as moved_since,
  s.status        as showing_status,
  coalesce(o.id, ob.id) as object_id,
  coalesce(o.address, t.title, ob.address) as address,
  n.task_id,
  t.title         as task_title,
  t.due_at        as task_due_at
from notifications n
left join showings s on s.id = n.showing_id
left join matches  m on m.id = s.match_id
left join objects  o on o.id = m.object_id
left join tasks    t on t.id = n.task_id
left join objects  ob on ob.id = n.object_id;

comment on view my_notifications_v is
  'Уведомления, видимые агенту (политика таблицы). Предмет — показ, задача или объект; «мне не пришло» должно иметь ответ во всех трёх случаях.';

grant select on my_notifications_v to authenticated;
