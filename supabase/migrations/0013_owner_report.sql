-- 0013_owner_report.sql
-- ИНВАРИАНТ 10: отчёт собственнику открывается только по действующему токену,
--               выданному владельцем мандата собственнику этого объекта.
--
-- Решает конкретный конфликт, описанный у JoyWork: объект не продаётся,
-- собственник считает, что агент плохо работает, а агент не может доказать
-- обратное. Отчёт показывает, где объект размещён, сколько было показов и с
-- какой реакцией — и тогда разговор идёт про цену, а не про старание.
--
-- Отчёт публичный: у собственника нет аккаунта и не должно быть. Поэтому
-- вся защита в трёх местах:
--
--   1. Токен выдаёт только listing-агент действующего мандата или админ,
--      и только контакту, который числится собственником ЭТОГО объекта.
--   2. Отозванный или истёкший токен не открывает ничего.
--   3. Функция отчёта — единственное, что доступно роли anon. Сама таблица
--      токенов ей не видна, поэтому перебрать или прочитать их нельзя.
--
-- Что отчёт НЕ показывает: ни комиссии, ни агентов, ни имён клиентов, ни
-- свободного текста с показов. Собственник видит работу по своему объекту,
-- а не чужие контакты — инвариант 4 действует и в эту сторону.

create table owner_access (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid not null references objects  (id) on delete cascade,
  contact_id    uuid not null references contacts (id) on delete cascade,

  -- Секрет из ссылки. 32 шестнадцатеричных знака — 128 бит случайности,
  -- без расширений: gen_random_uuid() есть в самом Postgres.
  token         text not null unique
                  check (token ~ '^[0-9a-f]{32}$'),

  issued_by_agent_id uuid not null references agents (id) on delete restrict,
  expires_at    timestamptz,
  revoked_at    timestamptz,

  -- Сколько раз собственник открывал отчёт. Агенту это говорит, дошла ли
  -- ссылка, а не только отправлена ли она.
  view_count    integer not null default 0,
  last_viewed_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table owner_access is
  'Инвариант 10. Токен отчёта собственнику. Роли anon НЕ видна: ей доступна только функция app.owner_report().';

create index owner_access_object_idx on owner_access (object_id, created_at desc);
create unique index owner_access_live_idx
  on owner_access (object_id, contact_id)
  where revoked_at is null;

comment on index owner_access_live_idx is
  'Одна действующая ссылка на пару объект-собственник: иначе отозвать доступ значило бы искать все выданные.';

-- ---------------------------------------------------------------------------
-- Инвариант 10: кому и кем выдаётся
-- ---------------------------------------------------------------------------

create or replace function app.check_owner_access() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_listing uuid;
begin
  -- Токен выдаётся собственнику ЭТОГО объекта, а не любому контакту.
  if not exists (
    select 1 from object_ownerships oo
     where oo.object_id = new.object_id
       and oo.contact_id = new.contact_id
       and oo.role in ('owner', 'co_owner', 'proxy')
  ) then
    raise exception
      'INVARIANT_10: контакт % не числится собственником объекта %',
      new.contact_id, new.object_id
      using errcode = 'check_violation';
  end if;

  -- Выдаёт тот, кто отвечает перед собственником, то есть listing-агент
  -- действующего мандата. Без мандата отчитываться не о чем.
  select m.listing_agent_id into v_listing
    from mandates m
   where m.object_id = new.object_id and m.status = 'active';

  if v_listing is null then
    raise exception
      'INVARIANT_10: на объекте % нет активного мандата, отчёт выдавать не о чем',
      new.object_id using errcode = 'check_violation';
  end if;

  if new.issued_by_agent_id <> v_listing and not app.is_admin() then
    raise exception
      'INVARIANT_10: ссылку выдаёт listing-агент мандата (%), а не любой агент',
      v_listing using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger b_owner_access
  before insert or update on owner_access
  for each row execute function app.check_owner_access();

create trigger a_touch_owner_access
  before update on owner_access
  for each row execute function app.touch_updated_at();

create trigger zz_audit_owner_access
  after insert or update or delete on owner_access
  for each row execute function app.write_audit('owner_access', 'id');

-- ---------------------------------------------------------------------------
-- Политики: агентам видно, анониму нет
-- ---------------------------------------------------------------------------

alter table owner_access enable row level security;

create policy owner_access_read on owner_access for select
  using (app.current_agent_id() is not null);

create policy owner_access_insert on owner_access for insert
  with check (issued_by_agent_id = app.current_agent_id() or app.is_admin());

create policy owner_access_update on owner_access for update
  using (issued_by_agent_id = app.current_agent_id() or app.is_admin());

create policy owner_access_delete on owner_access for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Выдача и отзыв
-- ---------------------------------------------------------------------------

create or replace function issue_owner_access(
  p_object_id  uuid,
  p_contact_id uuid,
  p_days       integer default 90
) returns owner_access
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       owner_access;
begin
  -- Повторная выдача той же паре возвращает ту же ссылку, а не плодит вторую:
  -- иначе отозвать доступ значило бы вспомнить все отправленные ссылки.
  select * into r from owner_access
   where object_id = p_object_id and contact_id = p_contact_id
     and revoked_at is null;

  if found then
    update owner_access
       set expires_at = case when p_days is null then null
                             else now() + make_interval(days => p_days) end
     where id = r.id
    returning * into r;
    return r;
  end if;

  insert into owner_access (object_id, contact_id, token, issued_by_agent_id, expires_at)
  values (p_object_id, p_contact_id,
          replace(gen_random_uuid()::text, '-', ''),
          v_agent,
          case when p_days is null then null
               else now() + make_interval(days => p_days) end)
  returning * into r;

  return r;
end $$;

comment on function issue_owner_access is
  'Инвариант 10. Выдать собственнику ссылку на отчёт. Повторный вызов продлевает существующую, а не создаёт вторую.';

create or replace function revoke_owner_access(p_object_id uuid, p_contact_id uuid)
  returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  perform app.require_agent();

  update owner_access set revoked_at = now()
   where object_id = p_object_id and contact_id = p_contact_id
     and revoked_at is null;

  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Сам отчёт
-- ---------------------------------------------------------------------------
-- Единственное, что доступно роли anon. Возвращает документ целиком, поэтому
-- анониму не нужны права ни на одну таблицу: ни перебрать токены, ни
-- заглянуть мимо отчёта нечем.

create or replace function app.owner_report(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a      owner_access%rowtype;
  o      objects%rowtype;
  v_out  jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;

  select * into a from owner_access where token = p_token;
  if not found
     or a.revoked_at is not null
     or (a.expires_at is not null and a.expires_at < now()) then
    return null;
  end if;

  select * into o from objects where id = a.object_id;
  if not found then
    return null;
  end if;

  -- Просмотр считается здесь: агенту важно знать, дошла ли ссылка.
  update owner_access
     set view_count = view_count + 1, last_viewed_at = now()
   where id = a.id;

  select jsonb_build_object(
    'object', jsonb_build_object(
      'address',           o.address,
      'zone',              o.zone,
      'kind',              o.kind,
      'deal_type',         o.deal_type,
      'rooms',             o.rooms,
      'area',              o.area,
      'floor',             o.floor,
      'floors_total',      o.floors_total,
      'price',             o.price,
      'currency',          o.currency,
      'publication_state', o.publication_state,
      'published_at',      o.published_at,
      'actual_at',         o.actual_at
    ),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel',      pc.channel,
               'status',       pc.status,
               'last_sync_at', pc.last_sync_at,
               'has_error',    pc.last_error is not null)
             order by pc.channel)
        from publication_channels pc where pc.object_id = o.id
    ), '[]'::jsonb),
    'showings', (
      select jsonb_build_object(
        'scheduled', count(*) filter (where s.status = 'scheduled'),
        'done',      count(*) filter (where s.status = 'done'),
        'cancelled', count(*) filter (where s.status in ('cancelled', 'no_show')),
        'last_done_at', max(s.done_at) filter (where s.status = 'done'),
        -- Только структурная реакция: свободный текст с показа собственнику
        -- не отдаётся, там чужие слова и чужие контакты.
        'outcomes', coalesce(jsonb_object_agg(s.outcome, s.cnt)
                     filter (where s.outcome is not null), '{}'::jsonb))
      from (
        select sh.status, sh.outcome, sh.done_at, count(*) over (
                 partition by sh.outcome) as cnt
          from showings sh
          join matches mt on mt.id = sh.match_id
         where mt.object_id = o.id
      ) s
    ),
    'interest', jsonb_build_object(
      'matches', (select count(*) from matches mt where mt.object_id = o.id),
      'rejected', (select count(*) from matches mt
                    where mt.object_id = o.id and mt.status = 'rejected')
    ),
    -- История цены берётся из журнала (инвариант 7): отдельной таблицы
    -- для неё нет и не нужно. Считаются только правки: у вставки в diff
    -- попадает вся строка, и создание объекта засчиталось бы как изменение
    -- цены, которого не было.
    'price_changes', (
      select jsonb_build_object(
        'count', count(*),
        'last_at', max(al.at))
        from audit_log al
       where al.entity_type = 'object' and al.entity_id = o.id
         and al.action = 'update'
         and al.diff ? 'price'
    ),
    'report', jsonb_build_object(
      'generated_at', now(),
      'views',        a.view_count + 1
    )
  ) into v_out;

  return v_out;
end $$;

comment on function app.owner_report is
  'Инвариант 10. Отчёт по токену. Ни комиссии, ни агентов, ни имён клиентов, ни свободного текста с показов.';

-- ---------------------------------------------------------------------------
-- Данные для кабинета агента
-- ---------------------------------------------------------------------------

create or replace view owner_access_v
  with (security_invoker = true) as
select
  oa.id,
  oa.object_id,
  o.address,
  oa.contact_id,
  c.name as contact_name,
  oa.token,
  oa.expires_at,
  oa.revoked_at,
  oa.view_count,
  oa.last_viewed_at,
  oa.issued_by_agent_id,
  (oa.revoked_at is null
   and (oa.expires_at is null or oa.expires_at > now())) as is_live
from owner_access oa
join objects o on o.id = oa.object_id
left join contacts c on c.id = oa.contact_id;

comment on view owner_access_v is
  'Выданные ссылки на отчёт. Имя собственника через LEFT JOIN: инвариант 4 скрывает имя, но не строку.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, insert, update on owner_access to authenticated;
grant select on owner_access_v to authenticated;
revoke all on owner_access, owner_access_v from anon;

grant execute on function
  issue_owner_access(uuid, uuid, integer),
  revoke_owner_access(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Доступ анонима к схеме app
-- ---------------------------------------------------------------------------
-- Отчёт живёт в схеме app, а роли anon эта схема до сих пор не открывалась:
-- 0006 выдал usage только authenticated и service_role. Без usage функция
-- недостижима, и страница отчёта падала бы «permission denied for schema app».
--
-- Но просто выдать usage нельзя. Postgres по умолчанию раздаёт EXECUTE на
-- новые функции роли PUBLIC, то есть всем. Тогда одного usage хватило бы,
-- чтобы аноним вызвал ЛЮБУЮ функцию схемы app, включая security definer.
-- Поэтому право сначала отбирается у PUBLIC и раздаётся поимённо.

grant usage on schema app to anon;

revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to authenticated;

-- Анониму нужны ровно две функции.
--
-- Отчёт — ради него всё и затевалось.
grant execute on function app.owner_report(text) to anon;

-- И app.current_agent_id(): её вызывает построчная политика на objects
-- («опубликованное видно всем, остальное только агентам»), а выражения
-- политики выполняются правами того, кто делает запрос. До сих пор это
-- работало только благодаря умолчанию PUBLIC, то есть случайно.
grant execute on function app.current_agent_id() to anon;
