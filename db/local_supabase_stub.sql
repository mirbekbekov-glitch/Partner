-- db/local_supabase_stub.sql
--
-- ТОЛЬКО ДЛЯ ЛОКАЛЬНОГО POSTGRES И ТЕСТОВ. Не миграция, в Supabase не применять:
-- там схема auth и роли уже существуют.
--
-- auth.uid() воспроизведён ровно так, как его определяет Supabase — читает sub
-- из GUC request.jwt.claims. Благодаря этому тесты проходят по тому же пути,
-- что и продакшен, а не по подменённой упрощённой функции.

create schema if not exists auth;

-- nullif(..., '') стоит ДО каста в jsonb, как в настоящем Supabase:
-- иначе `set request.jwt.claims = ''` падает на ''::jsonb, и тест «нет
-- сессии» невозможно выразить.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon'
  )
$$;

-- Минимальный слепок auth.users. Нужен, потому что app.ensure_agent()
-- берёт оттуда почту вошедшего. В Supabase таблица своя и богаче.
create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;
