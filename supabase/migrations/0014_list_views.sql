-- 0014_list_views.sql
-- Списки объектов и потребностей в кабинете.
--
-- Представления, а не запросы в коде: инвариант 4 должен держаться и при
-- прямом обращении к PostgREST, а не только через страницу.
--
-- Контакты собираются ПОДЗАПРОСАМИ, а не join-ом. Две причины. Первая:
-- у объекта может быть несколько собственников, и join размножил бы строки
-- объекта. Вторая: подзапрос, которому RLS не отдал ни строки, возвращает
-- NULL, а не выкидывает объект из списка — агент видит объект с пустым
-- собственником, что и требуется по инварианту 4.

-- ---------------------------------------------------------------------------
-- Список объектов
-- ---------------------------------------------------------------------------

create or replace view object_list_v
  with (security_invoker = true) as
select
  o.id,
  o.kind,
  o.deal_type,
  o.address,
  o.zone,
  o.rooms,
  o.area,
  o.floor,
  o.price,
  o.currency,
  o.publication_state,
  o.published_at,
  o.actual_at,
  o.created_at,
  o.created_by_agent_id,
  ca.full_name as created_by_name,

  -- Мандат: без активного объект нельзя опубликовать (инвариант 1),
  -- поэтому его состояние в списке видеть важнее всего.
  m.id                 as active_mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.valid_to           as mandate_valid_to,
  la.full_name         as listing_agent_name,

  -- Собственники. NULL, если инвариант 4 их этому агенту не отдаёт.
  (select string_agg(c.name, ', ' order by c.name)
     from object_ownerships oo
     join contacts c on c.id = oo.contact_id
    where oo.object_id = o.id
      and oo.role in ('owner', 'co_owner')) as owners,

  (select count(*) from matches mt where mt.object_id = o.id)      as matches_count,
  (select count(*) from matches mt
    where mt.object_id = o.id and mt.status = 'in_deal')           as deals_count,

  -- Индикативная комиссия. В публичную часть не выносится.
  app.commission_total(o.deal_type, o.price, m.commission_rule)    as commission_total
from objects o
left join mandates m  on m.object_id = o.id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join agents   ca on ca.id = o.created_by_agent_id;

comment on view object_list_v is
  'Список объектов в кабинете. Собственники подзапросом: несколько собственников не размножают объект, а скрытые по инварианту 4 дают NULL вместо исчезновения строки.';

-- ---------------------------------------------------------------------------
-- Список потребностей
-- ---------------------------------------------------------------------------

create or replace view requirement_list_v
  with (security_invoker = true) as
select
  r.id,
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms,
  r.deadline,
  r.requirements_text,
  r.status,
  r.created_at,
  r.updated_at,
  r.agent_id,
  ag.full_name as agent_name,

  -- Клиент. NULL, если инвариант 4 его этому агенту не отдаёт.
  r.contact_id,
  (select c.name from contacts c where c.id = r.contact_id) as client_name,

  (select count(*) from matches mt where mt.requirement_id = r.id)   as matches_count,
  (select count(*) from matches mt
    where mt.requirement_id = r.id
      and mt.status in ('showing_scheduled', 'showing_done'))        as showings_count,
  (select count(*) from matches mt
    where mt.requirement_id = r.id and mt.status = 'in_deal')        as deals_count
from requirements r
left join agents ag on ag.id = r.agent_id;

comment on view requirement_list_v is
  'Список потребностей в кабинете. Клиент подзапросом по той же причине, что собственники в object_list_v.';

grant select on object_list_v, requirement_list_v to authenticated;
revoke all   on object_list_v, requirement_list_v from anon;
