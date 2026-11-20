#!/usr/bin/env bash
# Проверка миграций в условиях, приближённых к настоящему Supabase.
#
# Зачем отдельно от db/rebuild.sh. Локально миграции применяются
# суперпользователем, и он обходит проверки прав — поэтому локальный прогон
# не видит зависимостей от привилегий, которых на Supabase нет. Эта проверка
# уже нашла одну: app.ensure_agent() читала auth.users и падала с
# «permission denied for table users».
#
# Отличия от локальной сборки:
#   • владелец миграций НЕ суперпользователь;
#   • схема auth и роли созданы ДО миграций и принадлежат не нам;
#   • auth.users принадлежит другой роли, как supabase_auth_admin.
set -uo pipefail

PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-55432}"; PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DB:-preflight}"

psql -q -d postgres -c "drop database if exists ${DB} with (force)" >/dev/null 2>&1
psql -q -d postgres -c "drop role if exists sb_owner" >/dev/null 2>&1
psql -q -d postgres -c "create role sb_owner login createrole createdb" >/dev/null
psql -q -d postgres -c "create database ${DB} owner sb_owner" >/dev/null

# Основание готовит суперпользователь: так же, как Supabase готовит проект
# до того, как туда попадают наши миграции.
psql -q -d "$DB" >/dev/null <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema auth authorization sb_owner;
-- Таблица остаётся за суперпользователем: на Supabase её владелец
-- supabase_auth_admin, а не роль миграций.
create table auth.users (id uuid primary key, email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub','')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant anon, authenticated, service_role to sb_owner;
create extension if not exists pgcrypto;
SQL

fail=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  out="$(psql -v ON_ERROR_STOP=1 -U sb_owner -d "$DB" -f "$f" 2>&1 | grep -iE 'error' | head -3)"
  if [ -n "$out" ]; then
    echo "  ✗ $(basename "$f")"; echo "$out" | sed 's/^/      /'; fail=$((fail+1))
  fi
done

if [ "$fail" -gt 0 ]; then
  echo ""; echo "  миграций с ошибками: $fail"; exit 1
fi
echo "  миграции применились ролью без прав суперпользователя"

# Дымовая проверка входа: именно она нашла зависимость от auth.users.
# Пользователя заводит суперпользователь: на Supabase auth.users наполняет
# служба аутентификации, а не роль миграций — ей эта таблица не принадлежит.
psql -q -d "$DB" -c "insert into auth.users (id, email)
  values ('11111111-1111-1111-1111-111111111111','preflight@partner.kg')
  on conflict do nothing" >/dev/null

out="$(psql -X -q -t -U sb_owner -d "$DB" 2>&1 <<'SQL'
set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"preflight@partner.kg"}';
set role authenticated;
select 'вход: ' || coalesce((ensure_agent()).email, '(без почты)');
reset role; reset request.jwt.claims;
set role anon;
select 'аноним и витрина: ' || (select count(*) from public_catalog_v)::text;
reset role;
SQL
)"
if echo "$out" | grep -iq 'error'; then
  echo "$out" | sed 's/^/  /'; echo "  дымовая проверка входа ПРОВАЛЕНА"; exit 1
fi
echo "$out" | grep -v '^ *$' | sed 's/^ */  /'

# Ключевая проверка: вход не должен зависеть от чтения auth.users. Отзываем
# права начисто и логинимся снова — почта обязана прийти из токена.
psql -q -d "$DB" -c "revoke all on auth.users from sb_owner, authenticated, anon" >/dev/null 2>&1
out2="$(psql -X -q -t -U sb_owner -d "$DB" 2>&1 <<'SQL'
set request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"nouser@partner.kg"}';
set role authenticated;
select 'вход без прав на auth.users: ' || coalesce((ensure_agent()).email, '(без почты)');
reset role;
SQL
)"
if echo "$out2" | grep -iq 'error'; then
  echo "$out2" | sed 's/^/  /'
  echo "  ПРОВАЛ: вход зависит от чтения auth.users"; exit 1
fi
echo "$out2" | grep -v '^ *$' | sed 's/^ */  /'
echo "  вход и публичный каталог работают, и вход не зависит от auth.users"
