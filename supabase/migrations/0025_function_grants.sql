-- 0025_function_grants.sql
--
-- ДЫРА: в Postgres EXECUTE на новую функцию по умолчанию выдан PUBLIC.
-- Поэтому все 52 функции схемы app были вызываемы любым вошедшим агентом,
-- а мои `grant execute ... to service_role` ничего не ограничивали —
-- доступ и так был у всех.
--
-- Проверено на схеме до этой миграции:
--
--   • app.expire_mandates() от имени обычного агента погасила 4 мандата и
--     ОПУСТОШИЛА каталог: опубликованных объектов было 3, стало 0. Любой
--     агент мог снять с публикации всё агентство одним вызовом.
--   • app.backfill_missing_mandates() от имени постороннего создала мандаты
--     по всем объектам без договора. Комиссию это не присвоило — функция
--     берёт listing-агента из created_by объекта, а не из вызывающего, —
--     но массовое создание договоров посторонним всё равно недопустимо.
--   • app.claim_notifications() и app.mark_notification() позволяли агенту
--     выгребать очередь напоминаний и помечать их отправленными.
--
-- Анонима спасало только то, что USAGE на схему app ему не выдан. То есть
-- защита держалась на одном грант-е уровнем выше, а не на самих функциях.
--
-- Лечение: снять дефолтный PUBLIC и выдать явно. Плюс проверка прав внутри
-- двух опасных функций — чтобы правило не зависело только от грантов.

revoke execute on all functions in schema app from public;

-- И на будущее: функции, создаваемые дальше, не получат PUBLIC по умолчанию.
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Что агенту действительно нужно
-- ---------------------------------------------------------------------------
-- Это не произвольный список. Представления объявлены security_invoker, то
-- есть выполняются ОТ ИМЕНИ агента, и функции внутри них он обязан иметь
-- право вызвать. То же касается выражений в политиках RLS. Если забыть
-- что-то здесь, кабинет перестанет читать данные — поэтому список сверен
-- прогоном тестов, а не памятью.

grant execute on function
  -- Опознание и права: используются и в политиках, и в представлениях.
  app.current_agent_id(),
  app.is_admin(),
  app.can_see_contact(uuid),
  app.can_edit_object(uuid),
  app.can_lead_match(uuid),
  app.is_deal_party(uuid),
  app.can_see_entity_activity(text, uuid),
  app.active_mandate_id(uuid),
  -- Комиссия: внутри deal_commission_v, match_commission_v, object_list_v.
  app.commission_total(deal_type, numeric, jsonb),
  app.commission_shares(numeric),
  app.commission_split_ratio(),
  -- Нормализация: внутри contact_duplicates_v и полезна сама по себе.
  app.normalize_phone(text),
  app.normalize_name(text),
  -- Подтверждение актуальности: публичная обёртка вызывает её от владельца,
  -- но агент зовёт и напрямую через app-версию в существующем коде.
  app.confirm_actual(uuid),
  -- Состояние расписания: не секрет, полезно видеть агенту.
  app.schedule_health()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Что нужно фоновому заданию
-- ---------------------------------------------------------------------------

-- Чистая машинная работа: агенту и админу в кабинете она ни к чему.
grant execute on function
  app.enqueue_due_reminders(interval),
  app.claim_notifications(integer),
  app.mark_notification(uuid, boolean, text)
  to service_role;

-- А это админ может захотеть запустить руками, не дожидаясь расписания:
-- app.schedule_health() показывает просроченные мандаты, и логично тут же
-- их погасить. Грант открыт роли authenticated, а не админу — роль в
-- Postgres одна на всех вошедших, — поэтому различает их проверка ВНУТРИ
-- функции. Обычный агент получит отказ, и это проверено тестом.
grant execute on function
  app.expire_mandates(),
  app.backfill_missing_mandates()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- И проверка внутри самих опасных функций
-- ---------------------------------------------------------------------------
-- Грант можно вернуть неосторожной миграцией — как и случилось в харнессе
-- тестов, где `grant execute on all functions in schema app` маскировал
-- настоящие границы. Поэтому правило живёт и внутри функции.
--
-- Условие `auth.uid() is null` оставляет рабочими миграции, psql и
-- service_role: там сессии нет. Это тот же приём, что в триггере прав
-- агента из 0011.

create or replace function app.expire_mandates() returns integer
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_count integer;
begin
  if auth.uid() is not null and not app.is_admin() then
    raise exception
      'FORBIDDEN: истечение мандатов — работа расписания, а не агента'
      using errcode = '42501',
            hint = 'Вызов снимает с публикации все объекты с просроченными договорами.';
  end if;

  with e as (
    update mandates
       set status = 'expired'
     where status = 'active'
       and valid_to is not null
       and valid_to < current_date
    returning 1
  ) select count(*) into v_count from e;
  return v_count;
end $$;

create or replace function app.backfill_missing_mandates()
  returns table (object_id uuid, mandate_id uuid)
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if auth.uid() is not null and not app.is_admin() then
    raise exception
      'FORBIDDEN: перенос объектов — разовая работа админа, а не агента'
      using errcode = '42501';
  end if;

  return query
  insert into mandates (
    object_id, kind, valid_from, valid_to, start_price,
    listing_agent_id, contract_confirmed, status
  )
  select
    o.id, 'non_exclusive',
    coalesce(o.published_at::date, o.created_at::date, current_date),
    null, o.price, o.created_by_agent_id, false, 'active'
  from objects o
  where not exists (select 1 from mandates m where m.object_id = o.id)
  returning mandates.object_id, mandates.id;
end $$;

-- app.expire_mandates() вызывается расписанием из 0009 от имени владельца
-- базы (сессии нет), поэтому проверка её не задевает.

-- ---------------------------------------------------------------------------
-- Публичный каталог не должен зависеть от схемы app
-- ---------------------------------------------------------------------------
-- Снятие дефолтного PUBLIC вскрыло то, что харнесс тестов маскировал:
-- политика objects_read вызывала app.current_agent_id(), а анониму ни USAGE
-- на схему app, ни EXECUTE на эту функцию миграциями не выдавались.
--
-- Проверено: анонимное чтение и public_catalog_v, и objects падало с
-- «permission denied for function current_agent_id». То есть публичный
-- каталог — то единственное, что обязано работать для всех, — в продакшене
-- был сломан, а тесты этого не видели: харнесс выдавал анониму права на
-- схему app, которых в продакшене нет.
--
-- Лечение не грантом, а разделением политики. Условие для анонима теперь
-- не содержит вызова функции вовсе, поэтому каталог не может сломаться
-- из-за прав на схему app. Политики складываются по OR, и роль у каждой
-- своя.

drop policy objects_read on objects;

-- Опубликованное видно всем, включая анонима. Ни одной функции в условии.
create policy objects_read_published on objects for select
  to anon, authenticated
  using (publication_state = 'published');

-- Неопубликованное — только одобренным агентам.
create policy objects_read_agent on objects for select
  to authenticated
  using (app.current_agent_id() is not null);

comment on policy objects_read_published on objects is
  'Публичный каталог. В условии НЕТ вызова функций: иначе каталог зависит от прав анонима на схему app, и это уже один раз его ломало.';

-- ---------------------------------------------------------------------------
-- Публичные обёртки для фонового задания
-- ---------------------------------------------------------------------------
-- PostgREST отдаёт только схему public — для ЛЮБОЙ роли, включая
-- service_role. Поэтому маршрут рассылки не мог вызвать app-функции, и это
-- поймала tests/check-rpc.sh, а не живой прогон.
--
-- Обёртки объявлены SECURITY INVOKER сознательно. SECURITY DEFINER здесь
-- был бы дырой: такая обёртка выполняется от владельца и обошла бы тот
-- самый грант, которым доступ и ограничен. INVOKER плюс грант только
-- service_role — и агенту обёртка недоступна.
--
-- И revoke from public обязателен: EXECUTE на новую функцию по умолчанию
-- выдан PUBLIC, поэтому без него обёртки были бы открыты всем — ровно та
-- ошибка, которую эта миграция и лечит.

create or replace function enqueue_due_reminders(p_horizon interval default interval '24 hours')
  returns table (r_kind notification_kind, r_enqueued integer)
  language sql as $$
  select * from app.enqueue_due_reminders(p_horizon)
$$;

create or replace function claim_notifications(p_limit integer default 50)
  returns table (
    id uuid, agent_id uuid, channel notification_channel,
    body text, telegram_id bigint, attempts smallint
  )
  language sql as $$
  select * from app.claim_notifications(p_limit)
$$;

create or replace function mark_notification(
  p_id uuid, p_ok boolean, p_error text default null
) returns void
  language sql as $$
  select app.mark_notification(p_id, p_ok, p_error)
$$;

revoke execute on function
  enqueue_due_reminders(interval),
  claim_notifications(integer),
  mark_notification(uuid, boolean, text)
  from public;

grant execute on function
  enqueue_due_reminders(interval),
  claim_notifications(integer),
  mark_notification(uuid, boolean, text)
  to service_role;
