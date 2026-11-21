-- 0030_object_source.sql
-- Чей это объект: фильтр источника в КАБИНЕТЕ.
--
-- Решение владельца: искать объекты других организаций нужно в CRM, а в
-- публичном каталоге такой возможности быть не должно — каталогом
-- пользуются не только агенты, и внутреннее устройство агентства их не
-- касается. Поэтому ничего из этого не попадает в public_catalog_v: там
-- по-прежнему нет ни агента, ни организации.
--
-- Ответственный за объект — listing-агент активного мандата. Если мандата
-- нет (объект-черновик), отвечает тот, кто его завёл: иначе такие объекты
-- выпадали бы из любого фильтра по источнику.
--
-- Колонки добавляются в КОНЕЦ представления: create or replace умеет
-- дописывать только с конца, вставка в середину роняет миграцию.

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

  m.id                 as active_mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.valid_to           as mandate_valid_to,
  la.full_name         as listing_agent_name,

  (select string_agg(c.name, ', ' order by c.name)
     from object_ownerships oo
     join contacts c on c.id = oo.contact_id
    where oo.object_id = o.id
      and oo.role in ('owner', 'co_owner')) as owners,

  (select count(*) from matches mt where mt.object_id = o.id)      as matches_count,
  (select count(*) from matches mt
    where mt.object_id = o.id and mt.status = 'in_deal')           as deals_count,

  app.commission_total(o.deal_type, o.price, m.commission_rule)    as commission_total,

  -- Источник: кто отвечает за объект и в каком он агентстве.
  coalesce(m.listing_agent_id, o.created_by_agent_id)              as responsible_agent_id,
  coalesce(la.full_name, ca.full_name)                             as responsible_name,
  coalesce(la.organization_id, ca.organization_id)                 as responsible_org_id,
  coalesce(lo.name, co.name)                                       as responsible_org_name
from objects o
left join mandates m  on m.object_id = o.id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join agents   ca on ca.id = o.created_by_agent_id
left join organizations lo on lo.id = la.organization_id
left join organizations co on co.id = ca.organization_id;

comment on view object_list_v is
  'Список объектов в кабинете. Собственники подзапросом: несколько собственников не '
  'размножают объект, а скрытые по инварианту 4 дают NULL вместо исчезновения строки. '
  'responsible_* — источник объекта для фильтра в CRM; в публичную витрину не выносится.';
