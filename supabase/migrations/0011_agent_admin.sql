-- 0011_agent_admin.sql
--
-- Закрывает возможность агента самому себя одобрить и повысить, и даёт
-- админу законные пути одобрения.
--
-- ДЫРА, которую здесь затыкаем. В 0006 политика agents_self_update
-- разрешала правку собственной строки (`auth_user_id = auth.uid()`), а грант
-- был выдан на таблицу целиком: `grant update on agents to authenticated`.
-- Вместе это позволяло любому агенту выполнить
--
--     update agents set status = 'approved', role = 'admin'
--      where auth_user_id = auth.uid();
--
-- и стать админом. Проверено на схеме до этой миграции — проходило.
-- Пока это возможно, экран одобрения агентов не значит ничего.

-- ---------------------------------------------------------------------------
-- Почта агента
-- ---------------------------------------------------------------------------
-- Без неё экран одобрения нечитаем: админ видит заявку, но не понимает, кто
-- её подал. Заполняется из auth.users при входе.

alter table agents add column if not exists email text unique;

comment on column agents.email is
  'Почта из auth.users, заполняется app.ensure_agent(). Нужна экрану одобрения, чтобы заявку можно было опознать.';

-- ---------------------------------------------------------------------------
-- Права: агент правит только своё имя и телефон
-- ---------------------------------------------------------------------------
-- Поколоночный грант вместо табличного. status, role, auth_user_id,
-- telegram_id и email агенту недоступны ни при какой политике.

revoke update on agents from authenticated;
grant update (full_name, phone) on agents to authenticated;

-- ---------------------------------------------------------------------------
-- И то же самое триггером, независимо от грантов
-- ---------------------------------------------------------------------------
-- Гранты можно выдать заново неосторожной миграцией. Триггер держит правило
-- вне зависимости от них — так же, как остальные инварианты.
--
-- Условие `auth.uid() is not null` оставляет прямой доступ к базе
-- (psql, service_role, миграции) рабочим. Это нужно, чтобы завести ПЕРВОГО
-- админа: пока админа нет, одобрить его некому.

create or replace function app.guard_agent_privileges() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if (new.status is distinct from old.status
      or new.role is distinct from old.role)
     and auth.uid() is not null
     and not app.is_admin() then
    raise exception
      'FORBIDDEN: статус и роль агента меняет только админ'
      using errcode = '42501',
            hint = 'Используйте app.approve_agent() / app.block_agent() / app.set_agent_role() от имени админа.';
  end if;
  return new;
end $$;

create trigger b_guard_agent_privileges
  before update of status, role on agents
  for each row execute function app.guard_agent_privileges();

-- ---------------------------------------------------------------------------
-- Законные пути админа
-- ---------------------------------------------------------------------------

-- Последнего админа нельзя ни заблокировать, ни разжаловать: иначе систему
-- можно запереть так, что одобрять новых агентов станет некому.
create or replace function app.assert_admin_remains(p_agent_id uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from agents
     where role = 'admin' and status = 'approved' and id <> p_agent_id
  ) then
    raise exception
      'LAST_ADMIN: это последний админ, одобрять агентов станет некому'
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function app.approve_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: одобрять агентов может только админ'
      using errcode = '42501';
  end if;

  update agents set status = 'approved' where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function app.block_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: блокировать агентов может только админ'
      using errcode = '42501';
  end if;

  -- Если блокируем админа — убедимся, что останется кто-то ещё.
  if exists (select 1 from agents
              where id = p_agent_id and role = 'admin' and status = 'approved') then
    perform app.assert_admin_remains(p_agent_id);
  end if;

  update agents set status = 'blocked' where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function app.set_agent_role(p_agent_id uuid, p_role agent_role)
  returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: роль агента меняет только админ'
      using errcode = '42501';
  end if;

  if p_role <> 'admin' then
    perform app.assert_admin_remains(p_agent_id);
  end if;

  update agents set role = p_role where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Вход: подхватываем почту
-- ---------------------------------------------------------------------------
-- p_full_name стал необязательным: при входе по почте имени ещё нет, и
-- осмысленное значение по умолчанию — сама почта.

create or replace function app.ensure_agent(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
  r       agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');

  insert into agents (auth_user_id, full_name, email)
  values (v_uid, v_name, v_email)
  on conflict (auth_user_id) do update
     -- Пустое имя существующее не затирает.
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         email      = coalesce(excluded.email, agents.email),
         updated_at = now()
  returning * into r;

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Что видит экран одобрения
-- ---------------------------------------------------------------------------
-- Отдельное представление, а не select по agents: только админу и только
-- то, что нужно для решения.

create or replace view admin_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.email, a.phone, a.telegram_id,
  a.role, a.status, a.created_at, a.updated_at,
  -- Чтобы админ видел, что человек уже успел наработать.
  (select count(*) from objects      o where o.created_by_agent_id = a.id) as objects_count,
  (select count(*) from contacts     c where c.owner_agent_id      = a.id) as contacts_count,
  (select count(*) from requirements r where r.agent_id            = a.id) as requirements_count
from agents a
where app.is_admin();

comment on view admin_agents_v is
  'Экран одобрения агентов. where app.is_admin() — не админу представление пусто.';

grant select on admin_agents_v to authenticated;
revoke all   on admin_agents_v from anon;

grant execute on function
  app.approve_agent(uuid), app.block_agent(uuid),
  app.set_agent_role(uuid, agent_role)
  to authenticated;
