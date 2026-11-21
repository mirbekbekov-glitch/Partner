-- 0029_organizations.sql
-- Организация: агентство недвижимости, в котором состоит агент.
--
-- Решение владельца: агент либо работает в агентстве («Этажи» и подобные),
-- либо сам по себе. Принадлежность он заявляет при регистрации.
--
-- Два правила, из которых следует всё остальное.
--
-- 1. Название нормализуется, и оно уникально. Иначе «Этажи», «этажи» и
--    «ЭТАЖИ» станут тремя разными агентствами, фильтр по источнику
--    развалится, а объединять их потом придётся руками. Тот же приём, что
--    у телефонов контактов (0021): ограничение, которое обходится
--    форматированием, хуже отсутствующего.
--
-- 2. Агент ЗАЯВЛЯЕТ агентство, но не подтверждает его. Иначе любой впишет
--    «Этажи» и прикроется чужой репутацией. Поэтому у связи есть отдельный
--    признак org_confirmed, и поднять его может только админ. Снять — может
--    и сам агент, сменив место работы: это не повышение прав.
--
-- Частный агент — это organization_id IS NULL, а не организация с именем
-- «Частный агент». Иначе такие агенты склеятся в одно несуществующее
-- агентство, и «Других организаций» начнёт показывать их вперемешку.

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  name_normalized text generated always as (app.normalize_name(name)) stored,
  -- Кто завёл. NULL — агента удалили, организация осталась.
  created_by_agent_id uuid references agents (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index organizations_name_key on organizations (name_normalized);

comment on table organizations is
  'Агентства недвижимости. Уникальность по нормализованному названию: '
  'иначе «Этажи» и «этажи» станут разными агентствами.';

alter table agents
  add column organization_id uuid references organizations (id) on delete set null,
  -- Подтверждение принадлежности. Поднимает только админ.
  add column org_confirmed boolean not null default false;

comment on column agents.organization_id is
  'Агентство агента. NULL — частный агент, а не организация с таким названием.';
comment on column agents.org_confirmed is
  'Админ подтвердил принадлежность. Агент заявляет сам, подтвердить себя не может.';

create index agents_organization_idx on agents (organization_id) where organization_id is not null;

-- Инвариант 7: организация — такая же сущность.
create trigger zz_audit_organizations after insert or update or delete on organizations
  for each row execute function app.write_audit('organization', 'id');
create trigger a_touch_organizations before update on organizations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------
alter table organizations enable row level security;

-- Список агентств видит любой вошедший агент: без него не выбрать своё
-- место работы и не отфильтровать выдачу по источнику.
create policy organizations_read on organizations for select to authenticated using (true);

grant select on organizations to authenticated;
revoke all on organizations from anon;
revoke insert, update, delete on organizations from authenticated;

-- ---------------------------------------------------------------------------
-- Подтверждение подделать нельзя
-- ---------------------------------------------------------------------------
-- 0011 закрыл самоповышение по status и role поколоночным грантом и
-- триггером. Новые колонки в грант не входят, то есть прямой UPDATE агенту
-- и так недоступен. Но функции ниже идут SECURITY DEFINER, и единственной
-- преградой осталась бы проверка внутри каждой. Поэтому правило переносим в
-- триггер: поднять org_confirmed может только админ, откуда бы вызов ни шёл.

create or replace function app.guard_org_confirmation() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if new.org_confirmed is distinct from old.org_confirmed
     and new.org_confirmed = true
     and auth.uid() is not null
     and not app.is_admin() then
    raise exception 'FORBIDDEN: подтвердить принадлежность к агентству может только админ'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger b_guard_org_confirmation before update on agents
  for each row execute function app.guard_org_confirmation();

-- ---------------------------------------------------------------------------
-- Агент заявляет своё агентство
-- ---------------------------------------------------------------------------

create or replace function app.set_my_organization(p_name text) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(coalesce(p_name, ''));
  v_me    uuid := app.current_agent_id();
  v_org   uuid;
  r       agents;
begin
  if v_uid is null or v_me is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'BAD_INPUT: название агентства от 2 до 120 символов'
      using errcode = 'check_violation';
  end if;

  -- Ищем по нормализованному названию, заводим только если такого нет.
  select id into v_org from organizations where name_normalized = app.normalize_name(v_name);
  if v_org is null then
    insert into organizations (name, created_by_agent_id) values (v_name, v_me)
    returning id into v_org;
  end if;

  update agents
     set organization_id = v_org,
         -- Смена места работы сбрасывает подтверждение: подтверждали
         -- принадлежность к прежнему агентству, а не к этому.
         org_confirmed = false,
         updated_at = now()
   where id = v_me
  returning * into r;
  return r;
end $$;

comment on function app.set_my_organization is
  'Агент заявляет своё агентство. Подтверждение не выдаётся: его ставит админ.';

create or replace function app.clear_my_organization() returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_me uuid := app.current_agent_id(); r agents;
begin
  if v_me is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;
  update agents set organization_id = null, org_confirmed = false, updated_at = now()
   where id = v_me returning * into r;
  return r;
end $$;

comment on function app.clear_my_organization is
  'Частный агент: связь с агентством снимается. Пустая организация не заводится.';

-- ---------------------------------------------------------------------------
-- Админ: подтверждение и переименование
-- ---------------------------------------------------------------------------

create or replace function app.confirm_agent_organization(p_agent_id uuid, p_confirmed boolean)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: подтверждать принадлежность к агентству может только админ'
      using errcode = '42501';
  end if;
  update agents set org_confirmed = coalesce(p_confirmed, false), updated_at = now()
   where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  if r.organization_id is null and r.org_confirmed then
    raise exception 'BAD_INPUT: нечего подтверждать — агент не указал агентство'
      using errcode = 'check_violation';
  end if;
  return r;
end $$;

create or replace function app.rename_organization(p_org_id uuid, p_name text)
  returns organizations
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r organizations; v_name text := btrim(coalesce(p_name, ''));
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: переименовать агентство может только админ'
      using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'BAD_INPUT: название агентства от 2 до 120 символов'
      using errcode = 'check_violation';
  end if;
  update organizations set name = v_name where id = p_org_id returning * into r;
  if r.id is null then
    raise exception 'агентство % не найдено', p_org_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Список агентств для выбора и для фильтра по источнику
-- ---------------------------------------------------------------------------

create or replace view organization_list_v
  with (security_invoker = true) as
select o.id,
       o.name,
       count(distinct a.id) filter (where a.status = 'approved') as agents_count,
       count(distinct a.id) filter (where a.status = 'approved' and a.org_confirmed) as confirmed_count
  from organizations o
  left join agents a on a.organization_id = o.id
 group by o.id, o.name
 order by o.name;

comment on view organization_list_v is
  'Агентства со счётчиком агентов — для выбора при регистрации и фильтра по источнику.';

grant select on organization_list_v to authenticated;
revoke all   on organization_list_v from anon;

-- ---------------------------------------------------------------------------
-- Публичные обёртки
-- ---------------------------------------------------------------------------
-- EXECUTE на новой функции схемы public достаётся PUBLIC по умолчанию
-- (0028). Для каждой новой обёртки право снимается и выдаётся явно.

create or replace function set_my_organization(p_name text) returns agents
  language sql as $$ select * from app.set_my_organization(p_name) $$;

create or replace function clear_my_organization() returns agents
  language sql as $$ select * from app.clear_my_organization() $$;

create or replace function confirm_agent_organization(p_agent_id uuid, p_confirmed boolean)
  returns agents
  language sql as $$ select * from app.confirm_agent_organization(p_agent_id, p_confirmed) $$;

create or replace function rename_organization(p_org_id uuid, p_name text) returns organizations
  language sql as $$ select * from app.rename_organization(p_org_id, p_name) $$;

grant execute on function
  app.set_my_organization(text), app.clear_my_organization(),
  app.confirm_agent_organization(uuid, boolean), app.rename_organization(uuid, text)
  to authenticated;

revoke execute on function
  set_my_organization(text), clear_my_organization(),
  confirm_agent_organization(uuid, boolean), rename_organization(uuid, text)
  from public;

grant execute on function
  set_my_organization(text), clear_my_organization(),
  confirm_agent_organization(uuid, boolean), rename_organization(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Экран одобрения: админ видит заявленное агентство
-- ---------------------------------------------------------------------------
-- Без этого подтверждать нечего: админ не увидит, что человек заявил.

-- Пересоздаём, а не заменяем: create or replace не умеет вставлять колонки
-- в середину — он меняет имена существующим и падает.
drop view admin_agents_v;

create view admin_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.email, a.phone, a.telegram_id,
  a.role, a.status, a.created_at, a.updated_at,
  a.organization_id,
  o.name as organization_name,
  a.org_confirmed,
  (select count(*) from objects      ob where ob.created_by_agent_id = a.id) as objects_count,
  (select count(*) from contacts     c  where c.owner_agent_id       = a.id) as contacts_count,
  (select count(*) from requirements r  where r.agent_id             = a.id) as requirements_count
from agents a
left join organizations o on o.id = a.organization_id
where app.is_admin();

comment on view admin_agents_v is
  'Экран одобрения агентов. where app.is_admin() — не админу представление пусто. '
  'Показывает заявленное агентство и признак подтверждения.';

grant select on admin_agents_v to authenticated;
revoke all   on admin_agents_v from anon;
