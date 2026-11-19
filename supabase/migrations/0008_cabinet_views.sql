-- 0008_cabinet_views.sql
-- Данные для минимального UI кабинета (пункт 4):
--   на карточке объекта      — список подборов,
--   на карточке потребности  — список подборов,
--   кнопка «создать подбор»  — функция create_match() из 0007.
--
-- Представления, а не запросы в коде кабинета: инвариант 4 должен держаться
-- и при прямом обращении к PostgREST.
--
-- Ключевая деталь: контакты присоединены LEFT JOIN. Агент, которому контакт
-- не положен, видит строку подбора с пустым именем — а не теряет строку
-- целиком, как было бы при INNER JOIN. Это и есть «объект, условия и
-- комиссия да, контакт нет».

-- ---------------------------------------------------------------------------
-- Подборы на карточке объекта
-- ---------------------------------------------------------------------------

create or replace view object_matches_v
  with (security_invoker = true) as
select
  mt.id                as match_id,
  mt.object_id,
  mt.requirement_id,
  mt.status            as match_status,
  mt.showing_at,
  mt.rejection_reason,
  mt.created_at,

  -- Агент, ведущий клиента.
  mt.closing_agent_id,
  ca.full_name         as closing_agent_name,

  -- Условия потребности: видны всем агентам.
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms              as rooms_wanted,
  r.deadline,
  r.status             as requirement_status,

  -- Контакт клиента: NULL, если инвариант 4 не даёт его этому агенту.
  r.contact_id,
  c.name               as client_name,

  -- Комиссия: индикативная, пока сделки нет.
  mc.commission_total,
  mc.listing_share,
  mc.closing_share,

  -- Есть ли по этому подбору живая сделка.
  d.id                 as deal_id,
  d.status             as deal_status
from matches mt
join      requirements r  on r.id  = mt.requirement_id
left join contacts     c  on c.id  = r.contact_id          -- LEFT: см. выше
left join agents       ca on ca.id = mt.closing_agent_id
left join match_commission_v mc on mc.match_id = mt.id
left join deals        d  on d.match_id = mt.id and d.status <> 'failed';

comment on view object_matches_v is
  'Пункт 4: список подборов на карточке объекта. Контакт через LEFT JOIN — подбор виден даже когда контакт по инварианту 4 закрыт.';

-- ---------------------------------------------------------------------------
-- Подборы на карточке потребности
-- ---------------------------------------------------------------------------

create or replace view requirement_matches_v
  with (security_invoker = true) as
select
  mt.id                as match_id,
  mt.requirement_id,
  mt.object_id,
  mt.status            as match_status,
  mt.showing_at,
  mt.rejection_reason,
  mt.created_at,

  -- Объект и его условия.
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
  o.actual_at,

  -- Мандат: условия договора видны всем агентам.
  m.id                 as mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.listing_agent_id,
  la.full_name         as listing_agent_name,

  -- Собственник: NULL, если инвариант 4 не даёт его этому агенту.
  oo.contact_id        as owner_contact_id,
  oc.name              as owner_name,

  mc.commission_total,
  mc.listing_share,
  mc.closing_share,

  d.id                 as deal_id,
  d.status             as deal_status
from matches mt
join      objects  o  on o.id = mt.object_id
left join mandates m  on m.object_id = mt.object_id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join object_ownerships oo on oo.object_id = mt.object_id and oo.role = 'owner'
left join contacts oc on oc.id = oo.contact_id              -- LEFT: см. выше
left join match_commission_v mc on mc.match_id = mt.id
left join deals    d  on d.match_id = mt.id and d.status <> 'failed';

comment on view requirement_matches_v is
  'Пункт 4: список подборов на карточке потребности. Собственник через LEFT JOIN по той же причине.';

grant select on object_matches_v, requirement_matches_v to authenticated;
revoke all   on object_matches_v, requirement_matches_v from anon;
