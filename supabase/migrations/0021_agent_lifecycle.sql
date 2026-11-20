-- 0021_agent_lifecycle.sql
-- ИНВАРИАНТ 17: агент работает только по решению администратора, сам себе
--               прав не выдаёт, и хотя бы один действующий администратор в
--               агентстве остаётся всегда.
--
-- Эта миграция закрывает дыру, найденную при подготовке кабинета агента, и
-- добавляет то, без чего кабинет вообще не работает.
--
-- ДЫРА. В 0006 роль authenticated получила `grant update on agents`, а
-- политика agents_self_update разрешает агенту менять свою строку:
--
--     create policy agents_self_update on agents for update
--       using (auth_user_id = auth.uid() or app.is_admin());
--
-- Политики RLS работают со строками, а не со столбцами. Значит «свою строку»
-- означало и свои status с role. Проверено запросом от имени обычного
-- одобренного агента:
--
--     update agents set role = 'admin' where auth_user_id = auth.uid();
--     select app.is_admin();   -- true
--
-- Одним запросом через PostgREST агент становился администратором, а это
-- доступ ко всем телефонам собственников (инвариант 4), одобрение других
-- агентов, выдача ссылок собственникам и запуск плановых работ. Неодобренного
-- агента от этого спасала случайность: политика чтения не показывает ему ни
-- одной строки, поэтому его UPDATE не находил, что обновлять.
--
-- ПОЧЕМУ ЭТО НЕ ПОЙМАЛИ РАНЬШЕ. Инвариант 4 проверяет, что телефон виден
-- правильным людям, и админ в этом списке есть законно. Ни один тест не
-- спрашивал, как человек становится админом. Это тот же разрыв, что в
-- инварианте 15: проверяли, что нужное работает, а не что лишнее запрещено.
--
-- ЧИНИТСЯ ТРЕМЯ СЛОЯМИ, и каждый нужен по своей причине.
--
--   1. Права на столбцы. RLS столбцов не различает, а грант различает:
--      агенту разрешено менять только своё имя и Telegram. Это главный слой —
--      он не зависит ни от одной написанной нами проверки.
--   2. Триггер. Смена status и role из приложения — только администратором.
--      Слой нужен потому, что функции security definer права на столбцы
--      обходят: любая будущая функция, забывшая проверку, упрётся в триггер.
--   3. Последний администратор. Разжаловать или заблокировать единственного
--      действующего админа нельзя — иначе агентство запирает себя снаружи, и
--      одобрять новых агентов станет некому вообще.

-- ---------------------------------------------------------------------------
-- 1. Права на столбцы
-- ---------------------------------------------------------------------------

revoke update on agents from authenticated;

-- Агент меняет про себя ровно две вещи. Телефона здесь нет сознательно: это
-- ключ личности (инвариант 6), и менять его можно только подтверждением
-- нового номера кодом, а не правкой поля.
grant update (full_name, telegram_id) on agents to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Триггер: status и role меняет администратор
-- ---------------------------------------------------------------------------

create or replace function app.check_agent_privilege_change() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_other_admins integer;
begin
  if tg_op = 'UPDATE'
     and new.status = old.status and new.role = old.role then
    return new;
  end if;

  -- Признак «запрос от вошедшего человека» — это auth.uid(), а не
  -- current_user. Первая версия триггера смотрела на current_user и не
  -- работала вовсе: внутри функции security definer current_user — это
  -- владелец функции, то есть postgres, и проверка всегда пропускала. Тест
  -- с нарочно забывшей проверку функцией это поймал.
  --
  -- Миграции, сценарии наполнения и плановые работы идут без входа
  -- (auth.uid() = null) и правило не нарушают: владелец базы и так может всё,
  -- и делать вид, что триггер его останавливает, незачем.
  if auth.uid() is not null and not app.is_admin() then
    raise exception 'INVARIANT_17: статус и роль агента меняет только администратор'
      using errcode = '42501';
  end if;

  -- Последний действующий администратор. Считаем по старой строке: уходит ли
  -- из состава админов тот, кто в нём был.
  if tg_op = 'DELETE' or old.role = 'admin' and old.status = 'approved' then
    if (tg_op = 'DELETE' and old.role = 'admin' and old.status = 'approved')
       or (tg_op = 'UPDATE' and not (new.role = 'admin' and new.status = 'approved')) then
      select count(*) into v_other_admins
        from agents a
       where a.role = 'admin' and a.status = 'approved' and a.id <> old.id;
      if v_other_admins = 0 then
        raise exception 'INVARIANT_17: в агентстве должен остаться хотя бы один действующий администратор'
          using errcode = 'raise_exception',
                hint = 'Сначала назначьте администратором кого-то ещё.';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

comment on function app.check_agent_privilege_change is
  'Инвариант 17. Статус и роль агента меняет администратор; последний действующий администратор не исчезает.';

create trigger c_agent_privilege_change
  before update or delete on agents
  for each row execute function app.check_agent_privilege_change();

-- ---------------------------------------------------------------------------
-- 3. Решения администратора
-- ---------------------------------------------------------------------------
-- Без этих функций кабинет не работает: первый вошедший агент получает
-- status = 'pending' и остаётся в нём навсегда, потому что одобрить его нечем.

create or replace function approve_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: агентов одобряет администратор'
      using errcode = '42501';
  end if;

  update agents set status = 'approved', updated_at = now()
   where id = p_agent_id
  returning * into r;

  if r.id is null then
    raise exception 'агент % не существует', p_agent_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function approve_agent is
  'Инвариант 17. Одобрение агента: до этого CRM для него закрыта.';

create or replace function block_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  r       agents;
  v_me    uuid := app.current_agent_id();
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: агентов блокирует администратор'
      using errcode = '42501';
  end if;

  -- Себя заблокировать нельзя. Правило последнего админа этого не покрывает:
  -- при двух админах такая блокировка законна, но это всегда ошибка руки, а
  -- не решение. Разблокировать себя заблокированный уже не сможет.
  if p_agent_id = v_me then
    raise exception 'INVARIANT_17: себя заблокировать нельзя'
      using errcode = 'raise_exception',
            hint = 'Попросите другого администратора.';
  end if;

  update agents set status = 'blocked', updated_at = now()
   where id = p_agent_id
  returning * into r;

  if r.id is null then
    raise exception 'агент % не существует', p_agent_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function block_agent is
  'Инвариант 17. Блокировка агента. Себя заблокировать нельзя.';

create or replace function set_agent_role(p_agent_id uuid, p_role agent_role)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: роли назначает администратор'
      using errcode = '42501';
  end if;

  update agents set role = p_role, updated_at = now()
   where id = p_agent_id
  returning * into r;

  if r.id is null then
    raise exception 'агент % не существует', p_agent_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function set_agent_role is
  'Инвариант 17. Назначение роли. Последнего действующего администратора разжаловать нельзя — это проверяет триггер.';

-- ---------------------------------------------------------------------------
-- Кто я и кто в агентстве
-- ---------------------------------------------------------------------------
-- Кабинету нужно знать, кто вошёл: имя в шапке, роль для скрытия админских
-- экранов и статус, чтобы неодобренному показать «ждите», а не пустые списки.

-- Политика чтения из 0006 показывает агентов только одобренному агенту, и
-- неодобренный не видел даже собственной строки. Для кабинета это тупик: ему
-- нечего показать человеку, который вошёл и ждёт решения, — экран выглядел бы
-- как сломанный вход. Политики складываются по ИЛИ, поэтому своя строка
-- добавляется, не расширяя ничего другого.
create policy agents_read_self on agents for select
  using (auth_user_id = auth.uid());

create or replace view me_v
  with (security_invoker = true) as
select a.id, a.full_name, a.phone, a.role, a.status, a.phone_verified_at,
       a.telegram_id, a.created_at,
       app.is_admin() as is_admin
  from agents a
 where a.auth_user_id = auth.uid();

comment on view me_v is
  'Текущий вошедший агент. Пустая выборка означает, что входа нет или агент не одобрен.';

create or replace view agency_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.phone, a.role, a.status, a.created_at, a.phone_verified_at,
  (select count(*) from objects o where o.created_by_agent_id = a.id) as objects_total,
  (select count(*) from mandates m
    where m.listing_agent_id = a.id and m.status = 'active')          as mandates_active,
  (select count(*) from deals d
    where d.status = 'closed'
      and (d.listing_agent_id = a.id or d.closing_agent_id = a.id))    as deals_closed
  from agents a
 order by
   -- Ожидающие одобрения первыми: это очередь, а не справочник.
   case a.status when 'pending' then 0 when 'approved' then 1 else 2 end,
   a.full_name;

comment on view agency_agents_v is
  'Состав агентства для администратора: кого одобрить и кто чем занят.';

grant select on me_v, agency_agents_v to authenticated;

revoke execute on function app.check_agent_privilege_change() from public;
revoke execute on function approve_agent(uuid), block_agent(uuid),
                           set_agent_role(uuid, agent_role) from public;
grant  execute on function approve_agent(uuid), block_agent(uuid),
                           set_agent_role(uuid, agent_role) to authenticated;
