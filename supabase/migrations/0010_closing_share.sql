-- 0010_closing_share.sql
-- ИНВАРИАНТ 3, вторая редакция: ставку вознаграждения назначает владелец мандата.
--
-- Было: делёж строго 50/50, зашитый в app.commission_split_ratio().
-- Стало: 50/50 остаётся значением по умолчанию, но мандат может нести свою
-- долю агента покупателя. Решение принято по итогам обзора рынка: JoyWork,
-- единственная система с настоящими партнёрскими сделками, даёт агенту
-- продавца назначать вознаграждение коллеге самому, и именно это мотивирует
-- приводить покупателей на чужой объект.
--
-- Что НЕ меняется:
--   — база комиссии (продажа 2%, аренда 50% первого месяца) и правило мандата;
--   — стороны: listing из мандата, closing из подбора;
--   — две доли всегда складываются ровно в итог;
--   — после закрытия суммы зафиксированы и не пересчитываются.
--
-- Что добавляется:
--   — mandates.closing_share_ratio: доля агента покупателя, NULL = 50/50;
--   — ставку назначает только listing-агент мандата или админ;
--   — ставку нельзя изменить, если по мандату есть закрытая сделка: иначе
--     зафиксированные в сделке суммы противоречили бы мандату.

-- ---------------------------------------------------------------------------
-- Ставка в мандате
-- ---------------------------------------------------------------------------

alter table mandates
  add column closing_share_ratio numeric(5,4)
    check (closing_share_ratio is null
           or (closing_share_ratio >= 0 and closing_share_ratio <= 1));

comment on column mandates.closing_share_ratio is
  'Инвариант 3. Доля агента покупателя от итоговой комиссии: 0.3 это 30%. NULL — делёж 50/50 по умолчанию.';

-- ---------------------------------------------------------------------------
-- Доли с учётом ставки
-- ---------------------------------------------------------------------------
-- Остаток от округления по-прежнему достаётся listing-агенту, чтобы сумма
-- долей была равна итогу в точности, а не с точностью до копейки.

create or replace function app.commission_shares(
  p_total         numeric,
  p_closing_ratio numeric default null
) returns table (listing_share numeric, closing_share numeric)
  language sql immutable as $$
  select
    p_total - round(p_total * coalesce(p_closing_ratio, 1 - app.commission_split_ratio()), 2),
    round(p_total * coalesce(p_closing_ratio, 1 - app.commission_split_ratio()), 2)
$$;

comment on function app.commission_shares(numeric, numeric) is
  'Инвариант 3. Вторым аргументом идёт ставка из мандата; NULL даёт 50/50. Остаток округления у listing-агента.';

-- ---------------------------------------------------------------------------
-- Ставку нельзя переписать после закрытой сделки
-- ---------------------------------------------------------------------------

create or replace function app.check_closing_share_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.closing_share_ratio is distinct from old.closing_share_ratio
     and exists (select 1 from deals d
                  where d.mandate_id = new.id and d.status = 'closed') then
    raise exception
      'INVARIANT_3: по мандату есть закрытая сделка, ставку менять нельзя'
      using errcode = 'check_violation',
            hint = 'Доли закрытой сделки зафиксированы и должны сходиться с мандатом.';
  end if;
  return new;
end $$;

create trigger c_mandate_closing_share
  before update of closing_share_ratio on mandates
  for each row execute function app.check_closing_share_change();

-- ---------------------------------------------------------------------------
-- Фиксация при закрытии сделки — теперь по ставке мандата
-- ---------------------------------------------------------------------------

create or replace function app.on_deal_closed() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_total numeric;
  v_rule  jsonb;
  v_type  deal_type;
  v_ratio numeric;
  s       record;
begin
  if new.status = 'closed' and coalesce(old.status, 'deposit') <> 'closed' then
    select o.deal_type, m.commission_rule, m.closing_share_ratio
      into v_type, v_rule, v_ratio
      from objects o
      join mandates m on m.id = new.mandate_id
     where o.id = new.object_id;

    -- Инвариант 3: после закрытия считаем от ФИНАЛЬНОЙ цены и фиксируем,
    -- по ставке, которая действовала в мандате на момент закрытия.
    v_total := app.commission_total(v_type, new.final_price, v_rule);
    select * into s from app.commission_shares(v_total, v_ratio);

    update deals
       set commission_total = v_total,
           listing_share    = s.listing_share,
           closing_share    = s.closing_share,
           closed_at        = coalesce(new.closed_at, now())
     where id = new.id;

    -- Инвариант 2: закрытие сделки закрывает её мандат и её потребность.
    update mandates
       set status = 'closed_by_deal',
           closed_reason = 'закрыт сделкой ' || new.id::text
     where id = new.mandate_id
       and status <> 'closed_by_deal';

    update requirements
       set status = 'closed',
           closed_reason = 'закрыта сделкой ' || new.id::text
     where id = new.requirement_id
       and status <> 'closed';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Представления комиссии считают по ставке
-- ---------------------------------------------------------------------------

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
               app.commission_total(o.deal_type, o.price, m.commission_rule),
               m.closing_share_ratio) s)
  end as listing_share,
  case when d.status = 'closed'
       then d.closing_share
       else (select s.closing_share from app.commission_shares(
               app.commission_total(o.deal_type, o.price, m.commission_rule),
               m.closing_share_ratio) s)
  end as closing_share,
  -- Новая колонка дописана в конец: порядок существующих колонок замена
  -- представления менять не умеет, а кабинетные виды из 0008 на них опираются.
  coalesce(m.closing_share_ratio, 1 - app.commission_split_ratio()) as closing_share_ratio
from deals d
join objects  o on o.id = d.object_id
join mandates m on m.id = d.mandate_id;

comment on view deal_commission_v is
  'Инвариант 3. is_indicative=true — сумма считается от текущей цены и будет пересчитана при закрытии. В публичную часть не выносить.';

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
     app.commission_total(o.deal_type, o.price, m.commission_rule),
     m.closing_share_ratio) s) as listing_share,
  (select s.closing_share from app.commission_shares(
     app.commission_total(o.deal_type, o.price, m.commission_rule),
     m.closing_share_ratio) s) as closing_share,
  coalesce(m.closing_share_ratio, 1 - app.commission_split_ratio()) as closing_share_ratio
from matches mt
join objects  o on o.id = mt.object_id
left join mandates m on m.object_id = mt.object_id and m.status = 'active';

-- Однорукая версия убирается: две перегрузки с одним смыслом это приглашение
-- вызвать не ту и молча потерять ставку. Вызов с одним аргументом работает
-- по-прежнему, потому что у второго есть значение по умолчанию.
drop function if exists app.commission_shares(numeric);

alter view deal_commission_v  set (security_invoker = true);
alter view match_commission_v set (security_invoker = true);

grant select on deal_commission_v, match_commission_v to authenticated;
revoke all on deal_commission_v, match_commission_v from anon;

-- ---------------------------------------------------------------------------
-- Слой доступа: назначить ставку
-- ---------------------------------------------------------------------------
-- Клиенту нечего передать неправильно: мандат проверяется на принадлежность
-- текущему агенту на сервере, а не в запросе.

create or replace function set_closing_share(
  p_mandate_id uuid,
  p_ratio      numeric
) returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  m       mandates%rowtype;
  r       mandates;
begin
  select * into m from mandates where id = p_mandate_id;
  if not found then
    raise exception 'мандат % не найден', p_mandate_id using errcode = 'no_data_found';
  end if;

  if m.listing_agent_id <> v_agent and not app.is_admin() then
    raise exception
      'INVARIANT_3: ставку назначает владелец мандата, а не любой агент'
      using errcode = '42501';
  end if;

  if p_ratio is not null and (p_ratio < 0 or p_ratio > 1) then
    raise exception 'INVARIANT_3: ставка должна быть от 0 до 1, получено %', p_ratio
      using errcode = 'check_violation';
  end if;

  update mandates set closing_share_ratio = p_ratio
   where id = p_mandate_id
  returning * into r;

  return r;
end $$;

comment on function set_closing_share is
  'Инвариант 3. Доля агента покупателя. NULL возвращает делёж по умолчанию 50/50.';

grant execute on function
  app.commission_shares(numeric, numeric),
  set_closing_share(uuid, numeric)
  to authenticated;
