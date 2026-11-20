-- 0026_auth_email_from_jwt.sql
--
-- Вход перестаёт зависеть от чтения auth.users.
--
-- ЧТО НАШЛОСЬ. Проверка на базе, подготовленной как настоящий проект
-- Supabase — схема auth создана не нами, владелец миграций НЕ
-- суперпользователь, — уронила app.ensure_agent():
--
--   ERROR: permission denied for table users
--   CONTEXT: select u.email from auth.users u where u.id = v_uid
--
-- Локально этого не видно: там владелец функции суперпользователь, а он
-- обходит проверки прав. То есть вход держался на привилегии, которой на
-- Supabase у роли миграций может не быть.
--
-- На живом Supabase роль postgres обычно ЧИТАЕТ auth.users, и там вход,
-- скорее всего, работал бы. Но зависимость всё равно лишняя: почта уже
-- есть в самом токене, за ней не нужно ходить в чужую схему.
--
-- Поэтому почта берётся из JWT через auth.jwt(), а чтение auth.users
-- остаётся запасным путём и обёрнуто в перехват исключения: если прав нет,
-- вход не падает, а просто обходится без почты.

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

  -- Основной путь: почта из токена. Никаких прав на чужие схемы не нужно.
  begin
    v_email := nullif(auth.jwt() ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  -- Запасной путь: таблица пользователей. Нет прав — не беда, вход важнее
  -- почты, и агент впишет имя сам.
  if v_email is null then
    begin
      select u.email into v_email from auth.users u where u.id = v_uid;
    exception when insufficient_privilege or undefined_table then
      v_email := null;
    end;
  end if;

  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');

  insert into agents (auth_user_id, full_name, email)
  values (v_uid, v_name, v_email)
  on conflict (auth_user_id) do update
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         email      = coalesce(excluded.email, agents.email),
         updated_at = now()
  returning * into r;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: вход. Почта берётся из JWT, а не из auth.users: чтение чужой схемы требует прав, которых у роли миграций на Supabase может не быть.';
