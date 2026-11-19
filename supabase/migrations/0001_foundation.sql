-- 0001_foundation.sql
-- Схема агентства недвижимости: основание.
-- Справочники значений, таблица агентов, помощники текущего пользователя.
--
-- Один человек — один аккаунт (инвариант 6): якорь — agents.telegram_id UNIQUE.
-- Владение объектами висит на стабильном agents.id, поэтому повторный вход
-- через Telegram не создаёт дубликат и не теряет владение.

create extension if not exists "pgcrypto";

create schema if not exists app;
comment on schema app is 'Внутренние помощники и проверки инвариантов. Не для прямого доступа клиента.';

-- ---------------------------------------------------------------------------
-- Справочники
-- ---------------------------------------------------------------------------

create type contact_kind       as enum ('person', 'company');
create type contact_role       as enum ('owner', 'buyer', 'tenant', 'landlord');
create type deal_type          as enum ('rent', 'sale');
create type object_kind        as enum ('flat', 'room', 'house', 'townhouse', 'land', 'commercial', 'garage');
create type publication_state  as enum ('draft', 'published', 'withdrawn');
create type ownership_role     as enum ('owner', 'co_owner', 'proxy', 'contact_person');
create type mandate_kind       as enum ('exclusive', 'non_exclusive');
create type agent_role         as enum ('agent', 'admin');
create type agent_status       as enum ('pending', 'approved', 'blocked');

-- Инвариант 1 и пункт переноса: 'requires_confirmation' НЕ отдельная ступень
-- перед активностью. Договор, не подтверждённый документом, остаётся активным
-- мандатом с contract_confirmed = false — иначе перенос существующих объектов
-- снял бы весь каталог с публикации.
create type mandate_status     as enum ('active', 'expired', 'terminated', 'closed_by_deal');

create type requirement_status as enum ('new', 'qualified', 'in_showings', 'in_deal', 'closed', 'lost');
create type match_status       as enum ('proposed', 'interested', 'showing_scheduled', 'showing_done', 'bargaining', 'rejected', 'in_deal');
create type deal_status        as enum ('deposit', 'documents', 'signing', 'settlement', 'closed', 'failed');
create type activity_kind      as enum ('call', 'showing', 'task', 'note', 'message');
create type publication_channel as enum ('site', 'mini_app', 'lalafo', 'house_kg');
create type channel_status     as enum ('exported', 'updated', 'error', 'withdrawn');
create type audit_action       as enum ('insert', 'update', 'delete');

-- ---------------------------------------------------------------------------
-- Агенты
-- ---------------------------------------------------------------------------

create table agents (
  id            uuid primary key default gen_random_uuid(),
  -- Привязка к существующей Telegram-идентичности. UNIQUE — это и есть
  -- инвариант 6 на уровне схемы: второй аккаунт на тот же Telegram невозможен.
  telegram_id   bigint      not null unique,
  -- Supabase auth.users.id. Заполняется при первом входе.
  auth_user_id  uuid                 unique,
  full_name     text        not null,
  phone         text,
  role          agent_role  not null default 'agent',
  -- CRM открывается только агентам со статусом «одобрен».
  status        agent_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column agents.telegram_id is
  'Инвариант 6: одна Telegram-идентичность — один аккаунт. Вход делает upsert по этому ключу, никогда insert новой строки.';

create index agents_status_idx on agents (status) where status = 'approved';

-- ---------------------------------------------------------------------------
-- Кто сейчас работает
-- ---------------------------------------------------------------------------

-- В Supabase auth.uid() берёт sub из request.jwt.claims. Тесты выставляют тот
-- же GUC, поэтому проверяется ровно тот путь, который работает в продакшене.
create or replace function app.current_agent_id() returns uuid
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select a.id from agents a
   where a.auth_user_id = auth.uid()
     and a.status = 'approved'
$$;

create or replace function app.is_admin() returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (
    select 1 from agents a
     where a.auth_user_id = auth.uid()
       and a.status = 'approved'
       and a.role = 'admin'
  )
$$;

-- Любое обращение из CRM требует одобренного агента.
create or replace function app.require_agent() returns uuid
  language plpgsql stable as $$
declare v uuid;
begin
  v := app.current_agent_id();
  if v is null then
    raise exception 'FORBIDDEN: требуется одобренный агент'
      using errcode = '42501';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Инвариант 6: вход по Telegram
-- ---------------------------------------------------------------------------

-- Единственный разрешённый путь создания/входа агента. ON CONFLICT по
-- telegram_id гарантирует, что повторный вход обновляет существующую строку,
-- а не создаёт вторую. agents.id не меняется, поэтому все FK на объекты,
-- мандаты и подборы остаются целыми.
create or replace function app.login_by_telegram(
  p_telegram_id  bigint,
  p_full_name    text,
  p_auth_user_id uuid default null
) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  insert into agents (telegram_id, full_name, auth_user_id)
  values (p_telegram_id, p_full_name, p_auth_user_id)
  on conflict (telegram_id) do update
     set full_name    = excluded.full_name,
         auth_user_id = coalesce(excluded.auth_user_id, agents.auth_user_id),
         updated_at   = now()
  returning * into r;
  return r;
end $$;
