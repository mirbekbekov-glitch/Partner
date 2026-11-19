-- 0006_rls.sql
-- ИНВАРИАНТ 4 и разделение «публичный каталог / CRM».
--
--   Телефон собственника и клиента виден только:
--     — owner_agent контакта,
--     — агентам внутри активной сделки по этому объекту,
--     — админу.
--   Остальным агентам: объект, условия и комиссия — да, контакт — нет.
--
-- Проверяется построчными политиками, поэтому правило действует и через
-- PostgREST напрямую, не только через UI.

-- ---------------------------------------------------------------------------
-- Предикат доступа к контакту
-- ---------------------------------------------------------------------------

create or replace function app.can_see_contact(p_contact_id uuid) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    app.is_admin()
    -- Кто привёл контакт.
    or exists (
      select 1 from contacts c
       where c.id = p_contact_id
         and c.owner_agent_id = app.current_agent_id()
    )
    -- Агент внутри активной сделки, где этот контакт — собственник объекта.
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
  'Инвариант 4. Подбор и назначенный показ доступа НЕ дают: нужна именно активная сделка.';

-- ---------------------------------------------------------------------------
-- Включаем RLS
-- ---------------------------------------------------------------------------

alter table agents              enable row level security;
alter table contacts            enable row level security;
alter table contact_phones      enable row level security;
alter table objects             enable row level security;
alter table object_ownerships   enable row level security;
alter table mandates            enable row level security;
alter table requirements        enable row level security;
alter table matches             enable row level security;
alter table deals               enable row level security;
alter table activities          enable row level security;
alter table publication_channels enable row level security;
alter table audit_log           enable row level security;

-- ---------------------------------------------------------------------------
-- Агенты
-- ---------------------------------------------------------------------------

create policy agents_read on agents for select
  using (app.current_agent_id() is not null or app.is_admin());

create policy agents_self_update on agents for update
  using (auth_user_id = auth.uid() or app.is_admin())
  with check (auth_user_id = auth.uid() or app.is_admin());

-- Создание агента — только через app.login_by_telegram (инвариант 6).
create policy agents_admin_write on agents for insert
  with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- Контакт и телефон — ядро инварианта 4
-- ---------------------------------------------------------------------------

create policy contacts_read on contacts for select
  using (app.can_see_contact(id));

create policy contacts_insert on contacts for insert
  with check (owner_agent_id = app.current_agent_id() or app.is_admin());

create policy contacts_update on contacts for update
  using (owner_agent_id = app.current_agent_id() or app.is_admin())
  with check (owner_agent_id = app.current_agent_id() or app.is_admin());

create policy contacts_delete on contacts for delete
  using (app.is_admin());

create policy contact_phones_read on contact_phones for select
  using (app.can_see_contact(contact_id));

create policy contact_phones_write on contact_phones for insert
  with check (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy contact_phones_update on contact_phones for update
  using (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy contact_phones_delete on contact_phones for delete
  using (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

-- ---------------------------------------------------------------------------
-- Объект: публичный каталог плюс полный доступ агентам
-- ---------------------------------------------------------------------------
-- Опубликованный объект виден всем, включая анонимов: это публичный каталог.
-- Неопубликованный — только одобренным агентам.

create policy objects_read on objects for select
  using (publication_state = 'published' or app.current_agent_id() is not null);

create policy objects_insert on objects for insert
  with check (created_by_agent_id = app.current_agent_id() or app.is_admin());

create policy objects_update on objects for update
  using (app.current_agent_id() is not null)
  with check (app.current_agent_id() is not null);

create policy objects_delete on objects for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Собственность: связь ведёт к контакту, поэтому закрыта так же
-- ---------------------------------------------------------------------------
-- Иначе object_ownerships выдала бы contact_id, и инвариант 4 обходился бы
-- join-ом в один шаг.

create policy ownerships_read on object_ownerships for select
  using (app.can_see_contact(contact_id));

create policy ownerships_write on object_ownerships for insert
  with check (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy ownerships_update on object_ownerships for update
  using (app.can_see_contact(contact_id));

create policy ownerships_delete on object_ownerships for delete
  using (app.can_see_contact(contact_id));

-- ---------------------------------------------------------------------------
-- Мандат: условия видны всем агентам, править может listing-агент
-- ---------------------------------------------------------------------------

create policy mandates_read on mandates for select
  using (app.current_agent_id() is not null);

create policy mandates_insert on mandates for insert
  with check (listing_agent_id = app.current_agent_id() or app.is_admin());

create policy mandates_update on mandates for update
  using (listing_agent_id = app.current_agent_id() or app.is_admin())
  with check (listing_agent_id = app.current_agent_id() or app.is_admin());

create policy mandates_delete on mandates for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Потребность: условия видны агентам, контакт за ними закрыт отдельно
-- ---------------------------------------------------------------------------

create policy requirements_read on requirements for select
  using (app.current_agent_id() is not null);

create policy requirements_insert on requirements for insert
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy requirements_update on requirements for update
  using (agent_id = app.current_agent_id() or app.is_admin())
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy requirements_delete on requirements for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Подбор и сделка: видны агентам, править — участникам
-- ---------------------------------------------------------------------------

create policy matches_read on matches for select
  using (app.current_agent_id() is not null);

create policy matches_insert on matches for insert
  with check (created_by_agent_id = app.current_agent_id() or app.is_admin());

create policy matches_update on matches for update
  using (app.current_agent_id() in (closing_agent_id, created_by_agent_id) or app.is_admin());

create policy matches_delete on matches for delete
  using (app.is_admin());

create policy deals_read on deals for select
  using (app.current_agent_id() is not null);

create policy deals_insert on deals for insert
  with check (app.current_agent_id() in (listing_agent_id, closing_agent_id) or app.is_admin());

create policy deals_update on deals for update
  using (app.current_agent_id() in (listing_agent_id, closing_agent_id) or app.is_admin());

create policy deals_delete on deals for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Активность: свободный текст, в котором легко окажется телефон
-- ---------------------------------------------------------------------------
-- Поэтому автор и админ, а не вся команда: иначе заметка «звонил, +996...»
-- обошла бы инвариант 4.

create policy activities_read on activities for select
  using (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_insert on activities for insert
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_update on activities for update
  using (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_delete on activities for delete
  using (agent_id = app.current_agent_id() or app.is_admin());

-- ---------------------------------------------------------------------------
-- Каналы публикации и журнал
-- ---------------------------------------------------------------------------

create policy channels_read on publication_channels for select
  using (app.current_agent_id() is not null);

create policy channels_write on publication_channels for all
  using (app.current_agent_id() is not null)
  with check (app.current_agent_id() is not null);

-- Журнал только читают, и только админ либо автор записи.
create policy audit_read on audit_log for select
  using (app.is_admin() or actor_agent_id = app.current_agent_id());

-- ---------------------------------------------------------------------------
-- Публичный каталог
-- ---------------------------------------------------------------------------
-- Единственное, что видит аноним. Ни контактов, ни комиссии, ни мандата:
-- «Не выносить комиссии в публичную часть».

create or replace view public_catalog_v
  with (security_invoker = true) as
select
  o.id, o.kind, o.deal_type, o.address, o.zone,
  o.rooms, o.area, o.floor, o.floors_total,
  o.price, o.currency, o.photos, o.description,
  o.published_at, o.actual_at
from objects o
where o.publication_state = 'published';

comment on view public_catalog_v is
  'Публичная витрина. Комиссия, контакты, мандаты и агенты сюда не попадают.';

-- ---------------------------------------------------------------------------
-- Права на роли
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app    to authenticated, service_role;

-- Аноним видит только витрину.
grant select on public_catalog_v to anon, authenticated;
grant select on objects          to anon;

-- Агент работает со всеми таблицами, объём отдаёт RLS.
grant select, insert, update, delete on
  contacts, contact_phones, objects, object_ownerships, mandates,
  requirements, matches, deals, activities, publication_channels
  to authenticated;
grant select on agents, audit_log to authenticated;
grant update on agents to authenticated;

-- Комиссия агентам, но не анонимам.
grant select on deal_commission_v, match_commission_v to authenticated;
revoke all on deal_commission_v, match_commission_v from anon;

grant execute on function
  app.current_agent_id(), app.is_admin(), app.can_see_contact(uuid),
  app.active_mandate_id(uuid), app.confirm_actual(uuid),
  app.commission_total(deal_type, numeric, jsonb), app.commission_shares(numeric),
  app.commission_split_ratio()
  to authenticated;

-- Представления комиссии должны уважать RLS вызывающего.
alter view deal_commission_v  set (security_invoker = true);
alter view match_commission_v set (security_invoker = true);
