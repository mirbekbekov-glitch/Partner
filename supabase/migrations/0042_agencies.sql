-- 0042_agencies.sql
-- ИНВАРИАНТ 33: агентств много, и чужая работа чужая.
--
-- До этой миграции система была однотенантной: «агент» означало «любой
-- одобренный агент», и этого хватало, пока агентство предполагалось одно.
-- Решение владельца продукта — несколько агентств города с мультилистингом,
-- и в этой модели прежние политики текут насквозь. Любой одобренный агент
-- видел:
--
--   — ВСЕХ клиентов всех агентств (`requirements_read`);
--   — ВСЕ сделки с суммами комиссий (`deals_read`);
--   — ВСЕ подборы (`matches_read`);
--   — ВСЕ договоры со стартовыми ценами и долями (`mandates_read`);
--   — ВСЕ ссылки на кабинеты собственников (`owner_access_read`).
--
-- Это не недосмотр в одной политике: так было спроектировано для одного
-- агентства. Теперь граница другая.
--
-- ЧТО ОСТАЁТСЯ ОБЩИМ — и это и есть платформа, а не вторая CRM:
--
--   — ОБЪЕКТЫ видны агентам всех агентств. Иначе мультилистинга нет;
--   — вместе с объектом видно ГЛАВНОЕ ОБ ЕГО ДОГОВОРЕ: тип и подписан ли.
--     Это ответ на вопрос «получу ли я комиссию, если приведу покупателя»,
--     и прятать его значит возвращать тот самый факап двух агентов;
--   — а вот стартовая цена, доля агента покупателя и условия комиссии —
--     не видны: это коммерческая тайна чужого агентства.
--
-- ПЕРЕХОД. Все существующие агенты попадают в одно агентство. Поэтому
-- сегодняшнее поведение не меняется ни на йоту, а изоляция начинает
-- действовать с появлением второго агентства.

create table agencies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  city        text not null default 'Бишкек',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint agencies_name_not_blank check (length(btrim(name)) > 0),
  constraint agencies_status_known check (status in ('active', 'blocked'))
);

comment on table agencies is
  'Инвариант 33. Агентство города. Клиенты, сделки и договоры принадлежат ему; объекты видны всем.';

create unique index agencies_name_idx on agencies (lower(btrim(name)));

insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa01', 'Liberterra');

alter table agents add column agency_id uuid references agencies(id) on delete restrict;

update agents set agency_id = '00000000-0000-0000-0000-00000000aa01';

alter table agents alter column agency_id set not null;
alter table agents alter column agency_id set default '00000000-0000-0000-0000-00000000aa01';

comment on column agents.agency_id is
  'Инвариант 33. Агентство агента. Менять его — это перевод между компаниями, а не правка профиля.';

create index agents_agency_idx on agents (agency_id);

create trigger a_touch_agencies
  before update on agencies
  for each row execute function app.touch_updated_at();

create trigger zz_audit_agencies
  after insert or update or delete on agencies
  for each row execute function app.write_audit('agency', 'id');

alter table agencies enable row level security;

create policy agencies_read on agencies for select
  using (app.current_agent_id() is not null);

grant select on agencies to authenticated;

-- ---------------------------------------------------------------------------
-- Кто свой
-- ---------------------------------------------------------------------------

create or replace function app.current_agency_id() returns uuid
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  -- `status = 'approved'` здесь не формальность, а то же условие, что в
  -- app.current_agent_id(). Без него неодобренный агент получал агентство,
  -- проходил app.same_agency() и видел договоры и клиентов компании ещё до
  -- одобрения — инвариант 17 падал на первом же прогоне.
  select a.agency_id from agents a
   where a.auth_user_id = auth.uid()
     and a.status = 'approved'
$$;

comment on function app.current_agency_id is
  'Инвариант 33. Агентство вошедшего ОДОБРЕННОГО агента. NULL для анонима, для службы входа и для ждущего одобрения.';

create or replace function app.same_agency(p_agent_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_agent_id is not null
     and exists (select 1 from agents a
                  where a.id = p_agent_id
                    and a.agency_id = app.current_agency_id())
$$;

comment on function app.same_agency is
  'Инвариант 33. Агент из моего агентства. Это и есть граница «своей организации».';

-- ---------------------------------------------------------------------------
-- Инвариант 33: чужая работа чужая
-- ---------------------------------------------------------------------------
-- Политики переписываются по одному правилу: видно то, что ведёт мой
-- агентство. Сделка — исключение: в ней две стороны, и видеть её обязаны оба
-- агентства, иначе мультилистинговая сделка не ведётся вовсе.

drop policy requirements_read on requirements;
create policy requirements_read on requirements for select
  using (app.same_agency(agent_id) or app.is_admin());

drop policy matches_read on matches;
create policy matches_read on matches for select
  using (
    app.same_agency(closing_agent_id)
    -- Агент объекта должен видеть подбор по своему объекту: иначе он не
    -- узнает, что к нему везут покупателя, и не сможет согласовать показ.
    or exists (select 1 from mandates md
                where md.object_id = matches.object_id
                  and md.status = 'active'
                  and app.same_agency(md.listing_agent_id))
    or app.is_admin());

drop policy deals_read on deals;
create policy deals_read on deals for select
  using (app.same_agency(listing_agent_id)
         or app.same_agency(closing_agent_id)
         or app.is_admin());

drop policy mandates_read on mandates;
create policy mandates_read on mandates for select
  using (app.same_agency(listing_agent_id) or app.is_admin());

drop policy owner_access_read on owner_access;
create policy owner_access_read on owner_access for select
  using (app.same_agency(issued_by_agent_id) or app.is_admin());

drop policy channels_read on publication_channels;
create policy channels_read on publication_channels for select
  using (
    exists (select 1 from mandates md
             where md.object_id = publication_channels.object_id
               and md.status = 'active'
               and app.same_agency(md.listing_agent_id))
    -- Договор мог кончиться, а разбираться с рекламой всё равно кому-то
    -- надо. Первая версия этого не учла, и каналы объекта с истёкшим
    -- договором исчезали у всех: экран «Площадки» показывал пустоту там,
    -- где объект продолжал висеть на площадке. То же правило, что в
    -- инварианте 22: объект без договора ведёт тот, кто его завёл.
    or exists (select 1 from objects o
                where o.id = publication_channels.object_id
                  and app.same_agency(o.created_by_agent_id))
    or app.is_admin());

-- ---------------------------------------------------------------------------
-- Что видно по чужому объекту
-- ---------------------------------------------------------------------------
-- Объект остаётся общим — в этом смысл платформы. Но без условий договора
-- чужой объект бесполезен: агент не знает, стоит ли везти клиента. Поэтому
-- рядом с объектом отдаётся ГЛАВНОЕ о договоре и НИЧЕГО о деньгах.

create or replace view listing_terms_v
  with (security_invoker = true) as
select
  o.id                  as object_id,
  o.address,
  o.publication_state,
  md.kind               as mandate_kind,
  md.contract_confirmed,
  md.valid_to,
  (md.id is not null)   as has_mandate,
  ag.id                 as agency_id,
  ag.name               as agency_name,
  a.id                  as listing_agent_id,
  a.full_name           as listing_agent_name,
  app.same_agency(md.listing_agent_id) as mine
from objects o
left join mandates md on md.object_id = o.id and md.status = 'active'
left join agents a    on a.id = md.listing_agent_id
left join agencies ag on ag.id = a.agency_id
where o.publication_state = 'published' or app.same_agency(o.created_by_agent_id);

comment on view listing_terms_v is
  'Инвариант 33. Условия работы по объекту для агента ЛЮБОГО агентства: тип договора, подписан ли он, чьё агентство ведёт. Стартовой цены, доли агента покупателя и условий комиссии здесь нет — это чужая коммерческая тайна.';

grant select on listing_terms_v to authenticated;
revoke all on listing_terms_v from anon;

-- Представление читает mandates, а политика на них своя — значит для чужого
-- объекта оно отдало бы пустоту. Нужна функция, которая смотрит шире, но
-- отдаёт только безопасные столбцы.
create or replace function app.listing_terms(p_object_id uuid)
  returns table (
    mandate_kind       mandate_kind,
    contract_confirmed boolean,
    valid_to           date,
    has_mandate        boolean,
    agency_name        text,
    listing_agent_name text,
    mine               boolean
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  select md.kind, md.contract_confirmed, md.valid_to, md.id is not null,
         ag.name, a.full_name, app.same_agency(md.listing_agent_id)
    from objects o
    left join mandates md on md.object_id = o.id and md.status = 'active'
    left join agents a    on a.id = md.listing_agent_id
    left join agencies ag on ag.id = a.agency_id
   where o.id = p_object_id
$$;

comment on function app.listing_terms is
  'Инвариант 33. То же, что listing_terms_v, но поверх политик: по чужому объекту договор не виден таблицей, а знать его условия агент обязан.';

revoke execute on function
  app.current_agency_id(), app.same_agency(uuid), app.listing_terms(uuid)
  from public;
grant execute on function
  app.current_agency_id(), app.same_agency(uuid), app.listing_terms(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Контакт — только своему агентству
-- ---------------------------------------------------------------------------
-- Инвариант 4 расширяется, а не отменяется: прежние условия остаются, но все
-- они теперь ещё и внутри агентства. Иначе агент чужого агентства, попавший
-- в сделку, видел бы контакт — это и задумано, — но и «кто привёл контакт»
-- перестало бы быть границей.

create or replace function app.can_see_contact(p_contact_id uuid) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    app.is_admin()
    -- Кто привёл контакт. ИМЕННО ОН, а не его агентство.
    --
    -- Первая версия этой миграции написала здесь app.same_agency(), и полный
    -- прогон немедленно показал, во что это обходится: «Айбек не видит
    -- телефон клиента, которого привёл Бакыт» перестало быть правдой.
    -- Инвариант 4 — построчная видимость контакта — защищает агента не от
    -- чужого агентства, а в первую очередь от коллеги по своему. Чиня
    -- утечку наружу, легко открыть утечку внутрь.
    or exists (
      select 1 from contacts c
       where c.id = p_contact_id
         and c.owner_agent_id = app.current_agent_id()
    )
    -- Агент внутри активной сделки, где этот контакт — собственник объекта.
    -- Здесь граница агентства НЕ ставится сознательно: в мультилистинговой
    -- сделке участвуют два агентства, и обе стороны обязаны видеть, с кем
    -- имеют дело. Это и есть co-broke.
    or exists (
      select 1
        from deals d
        join object_ownerships oo on oo.object_id = d.object_id
       where oo.contact_id = p_contact_id
         and d.status not in ('closed', 'failed')
         and app.current_agent_id() in (d.listing_agent_id, d.closing_agent_id)
    )
    -- Агент внутри активной сделки, где этот контакт — клиент.
    or exists (
      select 1
        from deals d
        join requirements r on r.id = d.requirement_id
       where r.contact_id = p_contact_id
         and d.status not in ('closed', 'failed')
         and app.current_agent_id() in (d.listing_agent_id, d.closing_agent_id)
    )
$$;


comment on function app.can_see_contact is
  'Инвариант 4. Контакт виден тому, КТО ЕГО ПРИВЁЛ, и обеим сторонам активной сделки — в том числе из разных агентств, это и есть co-broke. Агентство здесь границей НЕ является: коллега по компании чужого клиента не видит.';

-- ---------------------------------------------------------------------------
-- Агенты: имя чужого видно, его контакты — нет
-- ---------------------------------------------------------------------------
-- Знать, кто ведёт чужой объект, нужно. Знать его почту и телеграм — нет.

drop policy agents_read on agents;
create policy agents_read on agents for select
  using (app.same_agency(id) or app.is_admin());

create or replace view platform_agents_v
  with (security_invoker = false) as
select a.id, a.full_name, a.status, ag.id as agency_id, ag.name as agency_name,
       app.same_agency(a.id) as mine
  from agents a join agencies ag on ag.id = a.agency_id
 where a.status = 'approved';

comment on view platform_agents_v is
  'Инвариант 33. Кто есть на платформе: имя и агентство. Почты, телефона и телеграма чужого агента здесь нет.';

grant select on platform_agents_v to authenticated;
revoke all on platform_agents_v from anon;
