-- 0004_commission.sql
-- ИНВАРИАНТ 3: комиссия.
--
--   listing_agent  — из мандата
--   closing_agent  — из подбора
--   делёж          — 50/50
--   база           — продажа 2% цены, аренда 50% первого месяца
--   до закрытия    — индикативно, от текущей цены
--   после закрытия — от финальной цены, зафиксировано
--
-- Правило мандата (mandates.commission_rule) переопределяет базу данными,
-- а не кодом. NULL означает базовое правило.

-- Доля каждой стороны. 50/50 по заданию; вынесено в функцию, чтобы
-- возможное изменение было одной правкой, а не поиском 0.5 по кодовой базе.
create or replace function app.commission_split_ratio() returns numeric
  language sql immutable as $$ select 0.50::numeric $$;

-- ---------------------------------------------------------------------------
-- Итоговая сумма комиссии
-- ---------------------------------------------------------------------------

create or replace function app.commission_total(
  p_deal_type deal_type,
  p_price     numeric,
  p_rule      jsonb default null
) returns numeric
  language plpgsql immutable as $$
declare
  v_kind  text;
  v_value numeric;
begin
  if p_price is null or p_price <= 0 then
    return null;
  end if;

  v_kind  := p_rule ->> 'kind';
  v_value := (p_rule ->> 'value')::numeric;

  -- Базовое правило: правила нет, либо оно задано неполно.
  if v_kind is null or v_value is null then
    return round(
      case p_deal_type
        when 'sale' then p_price * 0.02   -- 2% цены
        when 'rent' then p_price * 0.50   -- 50% первого месяца
      end, 2);
  end if;

  return round(
    case v_kind
      when 'percent'      then p_price * v_value / 100.0
      when 'months_share' then p_price * v_value
      when 'fixed'        then v_value
      else
        case p_deal_type
          when 'sale' then p_price * 0.02
          when 'rent' then p_price * 0.50
        end
    end, 2);
end $$;

comment on function app.commission_total is
  'Инвариант 3. База: продажа 2% цены, аренда 50% первого месяца. commission_rule мандата переопределяет.';

-- Доля одной стороны. Остаток от округления отдаётся listing-агенту,
-- чтобы две доли всегда складывались ровно в итог.
create or replace function app.commission_shares(p_total numeric)
  returns table (listing_share numeric, closing_share numeric)
  language sql immutable as $$
  select
    p_total - round(p_total * (1 - app.commission_split_ratio()), 2),
    round(p_total * (1 - app.commission_split_ratio()), 2)
$$;

-- ---------------------------------------------------------------------------
-- Комиссия по сделке
-- ---------------------------------------------------------------------------
-- Закрытая сделка отдаёт зафиксированные суммы. Открытая считает от текущей
-- цены объекта и помечается как индикативная.

create or replace view deal_commission_v as
select
  d.id                as deal_id,
  d.object_id,
  d.mandate_id,
  d.status,
  d.listing_agent_id,
  d.closing_agent_id,
  (d.status = 'closed')                          as is_final,
  (d.status <> 'closed')                         as is_indicative,
  coalesce(d.final_price, o.price)               as basis_price,
  case when d.status = 'closed'
       then d.commission_total
       else app.commission_total(o.deal_type, o.price, m.commission_rule)
  end as commission_total,
  case when d.status = 'closed'
       then d.listing_share
       else (select s.listing_share from app.commission_shares(
               app.commission_total(o.deal_type, o.price, m.commission_rule)) s)
  end as listing_share,
  case when d.status = 'closed'
       then d.closing_share
       else (select s.closing_share from app.commission_shares(
               app.commission_total(o.deal_type, o.price, m.commission_rule)) s)
  end as closing_share
from deals d
join objects  o on o.id = d.object_id
join mandates m on m.id = d.mandate_id;

comment on view deal_commission_v is
  'Инвариант 3. is_indicative=true — сумма считается от текущей цены и будет пересчитана при закрытии. Во публичную часть не выносить.';

-- ---------------------------------------------------------------------------
-- Комиссия по подбору: всегда индикативная, сделки ещё нет
-- ---------------------------------------------------------------------------
-- Нужна кабинету: агент видит потенциал подбора до того, как сделка создана.

create or replace view match_commission_v as
select
  mt.id             as match_id,
  mt.object_id,
  mt.requirement_id,
  m.id              as mandate_id,
  m.listing_agent_id,
  mt.closing_agent_id,
  o.price           as basis_price,
  app.commission_total(o.deal_type, o.price, m.commission_rule) as commission_total,
  (select s.listing_share from app.commission_shares(
     app.commission_total(o.deal_type, o.price, m.commission_rule)) s) as listing_share,
  (select s.closing_share from app.commission_shares(
     app.commission_total(o.deal_type, o.price, m.commission_rule)) s) as closing_share
from matches mt
join objects  o on o.id = mt.object_id
left join mandates m on m.object_id = mt.object_id and m.status = 'active';
