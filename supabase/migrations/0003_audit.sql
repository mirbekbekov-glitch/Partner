-- 0003_audit.sql
-- ИНВАРИАНТ 7: каждое изменение сущности пишется в журнал — кто, что, когда.
--
-- Журнал ведёт одна универсальная триггерная функция, навешенная на все
-- содержательные таблицы. Писать журнал из кода приложения нельзя: любой
-- путь, который забыли обложить вызовом, молча выпадет из журнала. Триггер
-- ловит и прямые запросы к PostgREST, и psql, и фоновые задания.

create table audit_log (
  id             bigint generated always as identity primary key,
  entity_type    text   not null,
  entity_id      uuid   not null,
  action         audit_action not null,
  -- Кто. NULL означает системное действие (миграция, фоновое задание) —
  -- тогда смысл несёт actor_auth_uid или его отсутствие.
  actor_agent_id uuid references agents (id) on delete set null,
  actor_auth_uid uuid,
  -- Что. Для update только изменившиеся поля: {"price": {"from": 100, "to": 120}}.
  diff           jsonb  not null default '{}'::jsonb,
  at             timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id, at desc);
create index audit_log_actor_idx  on audit_log (actor_agent_id, at desc);
create index audit_log_at_idx     on audit_log (at desc);

comment on table audit_log is
  'Инвариант 7. Заполняется только триггером app.write_audit(), вручную не писать.';

-- ---------------------------------------------------------------------------
-- Разница двух снимков строки: только изменившиеся поля
-- ---------------------------------------------------------------------------

create or replace function app.jsonb_diff(p_old jsonb, p_new jsonb) returns jsonb
  language sql immutable as $$
  select coalesce(
    jsonb_object_agg(key, jsonb_build_object('from', p_old -> key, 'to', p_new -> key)),
    '{}'::jsonb
  )
  from (
    select jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) as key
  ) k
  where (p_old -> key) is distinct from (p_new -> key)
$$;

-- ---------------------------------------------------------------------------
-- Универсальный триггер журнала
-- ---------------------------------------------------------------------------

create or replace function app.write_audit() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_entity text := tg_argv[0];
  -- Не у каждой таблицы есть одиночный id: у object_ownerships ключ составной.
  -- Второй аргумент говорит, какую колонку брать за entity_id.
  v_keycol text := coalesce(nullif(tg_argv[1], ''), 'id');
  v_old    jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new    jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id     uuid;
  v_diff   jsonb;
  v_action audit_action;
  v_agent  uuid;
begin
  -- Агент может отсутствовать: системные операции, миграции, вход до того,
  -- как строка агента создана.
  begin
    select a.id into v_agent from agents a where a.auth_user_id = auth.uid();
  exception when others then
    v_agent := null;
  end;

  v_id := (coalesce(v_new, v_old) ->> v_keycol)::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'UPDATE' then
    v_action := 'update';
  else
    v_action := 'delete';
  end if;

  v_diff := app.jsonb_diff(v_old, v_new);

  -- updated_at из diff убираем: когда это было, уже сказано в audit_log.at,
  -- а триггер app.touch_updated_at() двигает его на КАЖДЫЙ update. Иначе
  -- «UPDATE ... set price = price» выглядел бы как настоящее изменение.
  v_diff := v_diff - 'updated_at';

  -- Пустой UPDATE журнал не засоряет.
  if tg_op = 'UPDATE' and v_diff = '{}'::jsonb then
    return new;
  end if;

  insert into audit_log (entity_type, entity_id, action, actor_agent_id, actor_auth_uid, diff)
  values (v_entity, v_id, v_action, v_agent, auth.uid(), v_diff);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Общий триггер updated_at
-- ---------------------------------------------------------------------------
-- Отдельно от actual_at: actual_at живёт по правилу инварианта 5 и обновляется
-- не на любое изменение, а только на цену, фото и подтверждение актуальности.

create or replace function app.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Навешиваем на все содержательные таблицы
-- ---------------------------------------------------------------------------
-- Список в одном месте: новая таблица — одна строка здесь, и она сразу
-- попадает и в журнал, и в updated_at.

do $$
declare
  t record;
begin
  for t in
    select * from (values
      -- таблица,               сущность,      есть updated_at, ключ для entity_id
      ('agents',              'agent',       true,  'id'),
      ('contacts',            'contact',     true,  'id'),
      ('contact_phones',      'contact_phone', false, 'id'),
      ('objects',             'object',      true,  'id'),
      -- составной ключ: в журнале сущность опознаётся по объекту,
      -- контакт и роль видны в diff
      ('object_ownerships',   'ownership',   false, 'object_id'),
      ('mandates',            'mandate',     true,  'id'),
      ('requirements',        'requirement', true,  'id'),
      ('matches',             'match',       true,  'id'),
      ('deals',               'deal',        true,  'id'),
      ('activities',          'activity',    true,  'id'),
      ('publication_channels','channel',     true,  'id')
    ) as v(tbl, entity, has_updated_at, keycol)
  loop
    execute format(
      'create trigger %I after insert or update or delete on %I
         for each row execute function app.write_audit(%L, %L)',
      'zz_audit_' || t.tbl, t.tbl, t.entity, t.keycol);

    if t.has_updated_at then
      execute format(
        'create trigger %I before update on %I
           for each row execute function app.touch_updated_at()',
        'a_touch_' || t.tbl, t.tbl);
    end if;
  end loop;
end $$;
