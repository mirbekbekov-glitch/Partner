-- 0012_public_api.sql
--
-- Публичные обёртки для функций, которые вызывает кабинет.
--
-- PostgREST выставляет наружу только функции из открытых схем, по умолчанию
-- public. Функции в схеме app через supabase.rpc() недоступны, поэтому
-- ensure_agent, approve_agent и прочее кабинету было не вызвать.
--
-- Обёртки, а не открытие схемы app целиком: открыв app, мы выставили бы
-- наружу и внутренности — app.can_see_contact(), app.write_audit(),
-- app.guard_agent_privileges(). Наружу должно смотреть только то, что
-- кабинету действительно нужно.
--
-- Обёртки намеренно пустые: вся проверка прав осталась внутри app.*,
-- поэтому обойти её, вызвав обёртку, нельзя.

create or replace function ensure_agent(p_full_name text default null)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.ensure_agent(p_full_name)
$$;

create or replace function approve_agent(p_agent_id uuid)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.approve_agent(p_agent_id)
$$;

create or replace function block_agent(p_agent_id uuid)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.block_agent(p_agent_id)
$$;

create or replace function set_agent_role(p_agent_id uuid, p_role agent_role)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.set_agent_role(p_agent_id, p_role)
$$;

create or replace function confirm_actual(p_object_id uuid)
  returns timestamptz language sql security definer set search_path = public, pg_temp as $$
  select app.confirm_actual(p_object_id)
$$;

grant execute on function
  ensure_agent(text), approve_agent(uuid), block_agent(uuid),
  set_agent_role(uuid, agent_role), confirm_actual(uuid)
  to authenticated;
