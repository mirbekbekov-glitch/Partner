-- 0047_object_search.sql
-- ИНВАРИАНТ 37: объект чужого агентства — рабочий объект, а не витринная
--               картинка. «Есть ли по нему договор» не зависит от того, в
--               каком агентстве смотрящий.
--
-- Задание звучало как экранное: «в объектах должен быть фильтр для поиска
-- подходящих и фильтр источника — мои, моей организации, другой». Проба
-- показала, что фильтровать по третьему значению сегодня нечего: объект
-- чужого агентства из работы выпадает.
--
--   в подборе всего (бюджет любой): 13
--   из них объект Альфы: 0
--   create_match по объекту Альфы: ПРОШЁЛ
--
-- Опубликованный объект с ПОДТВЕРЖДЁННЫМ эксклюзивом не нашёлся подбором, но
-- подбор по нему руками прошёл. То есть запрета нет — объект просто негде
-- взять: агент может предложить его клиенту, только если откуда-то знает
-- его UUID. Мультилистинг, ради которого платформа и существует, кончался
-- на границе агентства.
--
-- ПРИЧИНА. Инвариант 20 проверяет договор join'ом на mandates, а инвариант 33
-- сузил политику mandates до своего агентства. Два правильных правила дали
-- неправильное следствие: «нет договора» и «договор не виден мне» слились в
-- одно. Это тот же класс ошибки, что «агент — это не ЭТОТ агент», только про
-- таблицу: «договора нет» — это не «я не вижу договора».
--
-- ЧИНИТСЯ одним приёмом, который в 0042 уже применён поштучно: смотреть шире
-- политик, отдавать только безопасные столбцы. app.listing_terms() так и
-- сделана — но она берёт ОДИН объект, а подбору и поиску нужен набор.
--
-- ТО ЖЕ САМОЕ НАОБОРОТ. listing_funnel_v показывала объекты всех агентств, а
-- условия договора брала join'ом — и чужой объект с подтверждённым
-- эксклюзивом выходил в воронке как «договора нет», красным. Своя доска
-- работы — это работа СВОЕГО агентства, и теперь она им и ограничена.

-- ---------------------------------------------------------------------------
-- Договор объекта поверх политик: только безопасные столбцы
-- ---------------------------------------------------------------------------
-- Денег здесь нет и быть не может: ни стартовой цены, ни доли агента
-- покупателя, ни правила комиссии. Представление читают все агенты.

create or replace view app.object_terms_v
  with (security_invoker = false) as
select
  o.id                               as object_id,
  md.id is not null                  as has_mandate,
  md.kind                            as mandate_kind,
  md.contract_confirmed,
  md.valid_to,
  md.listing_agent_id,
  coalesce(md.listing_agent_id, o.created_by_agent_id) as holder_agent_id,
  coalesce(a.full_name, ca.full_name)                  as holder_agent_name,
  coalesce(ag.id, cag.id)                              as agency_id,
  coalesce(ag.name, cag.name)                          as agency_name
from objects o
left join mandates md on md.object_id = o.id and md.status = 'active'
left join agents a    on a.id = md.listing_agent_id
left join agencies ag on ag.id = a.agency_id
left join agents ca   on ca.id = o.created_by_agent_id
left join agencies cag on cag.id = ca.agency_id;

comment on view app.object_terms_v is
  'Инвариант 37. Договор объекта так, как его вправе видеть агент ЛЮБОГО агентства: тип, подписан ли, до какой даты, чьё агентство ведёт. Ни стартовой цены, ни долей, ни правила комиссии.';

grant select on app.object_terms_v to authenticated;

-- Источник объекта глазами текущего агента. Выводится, а не хранится:
-- «чей это объект» меняется вместе с договором, и второе поле с тем же
-- смыслом разошлось бы с первым в тот же день.
create or replace function app.object_source(p_holder uuid, p_agency uuid)
  returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when p_holder = app.current_agent_id()         then 'mine'
    when p_agency = app.current_agency_id()        then 'agency'
    else 'other'
  end
$$;

comment on function app.object_source is
  'Инвариант 37. Мой объект, объект моего агентства или чужого. Три значения, потому что права у них разные: своё правлю, агентства вижу целиком, чужое беру в работу по договору.';

revoke execute on function app.object_source(uuid, uuid) from public;
grant execute on function app.object_source(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- listing_terms_v теперь работает и через границу агентства
-- ---------------------------------------------------------------------------
-- До этой миграции представление отдавало по чужому объекту пустоту, и
-- рядом жила функция-дубль на один объект. Дубля больше нет: одно место.

create or replace view listing_terms_v
  with (security_invoker = true) as
select
  o.id            as object_id,
  o.address,
  o.publication_state,
  t.mandate_kind,
  t.contract_confirmed,
  t.valid_to,
  t.has_mandate,
  t.agency_id,
  t.agency_name,
  t.listing_agent_id,
  t.holder_agent_name as listing_agent_name,
  (t.agency_id = app.current_agency_id()) as mine
from objects o
join app.object_terms_v t on t.object_id = o.id
where o.publication_state = 'published' or app.same_agency(o.created_by_agent_id);

comment on view listing_terms_v is
  'Инвариант 37. Условия работы по объекту для агента ЛЮБОГО агентства: тип договора, подписан ли, чьё агентство ведёт. Стартовой цены, доли агента покупателя и условий комиссии здесь нет.';

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
  select t.mandate_kind, t.contract_confirmed, t.valid_to, t.has_mandate,
         t.agency_name, t.holder_agent_name,
         (t.agency_id = app.current_agency_id())
    from app.object_terms_v t
   where t.object_id = p_object_id
$$;

-- ---------------------------------------------------------------------------
-- Подбор: мультилистинг доходит до клиента
-- ---------------------------------------------------------------------------
-- Единственное изменение правила: действующий договор проверяется по
-- app.object_terms_v, а не join'ом на mandates. Всё остальное — то же самое,
-- плюс столбцы, без которых чужой объект брать в работу нельзя: чьё
-- агентство и какой договор.

-- Набор столбцов меняется, поэтому функция пересоздаётся, а не заменяется.
drop function app.matching_objects(uuid);

create function app.matching_objects(p_requirement_id uuid)
  returns table (
    object_id      uuid,
    address        text,
    kind           object_kind,
    zone           text,
    rooms          smallint,
    area           numeric,
    floor          smallint,
    floors_total   smallint,
    price          numeric,
    currency       text,
    actual_at      timestamptz,
    publication_state publication_state,
    photos_count   integer,
    listing_agent  text,
    is_mine        boolean,
    fit            text,
    already_proposed boolean,
    source         text,
    agency_name    text,
    mandate_kind   mandate_kind,
    contract_confirmed boolean
  )
  language sql stable security invoker set search_path = public, pg_temp as $$
  with req as (
    select * from requirements where id = p_requirement_id
  )
  select
    o.id, o.address, o.kind, o.zone, o.rooms, o.area, o.floor, o.floors_total,
    o.price, o.currency::text, o.actual_at, o.publication_state,
    (select count(*)::integer from object_photos p where p.object_id = o.id),
    t.holder_agent_name,
    (t.holder_agent_id = app.current_agent_id()),
    case
      when req.budget_max is not null and o.price > req.budget_max then 'чуть дороже'
      else 'подходит'
    end,
    exists (select 1 from matches mt
             where mt.object_id = o.id and mt.requirement_id = req.id),
    app.object_source(t.holder_agent_id, t.agency_id),
    t.agency_name,
    t.mandate_kind,
    t.contract_confirmed
  from req
  join objects o
    on o.deal_type = req.deal_type
   -- Договор: без него предлагать нечего. Берётся поверх политик — иначе
   -- «договор не виден мне» читается как «договора нет», и объект чужого
   -- агентства выпадает из подбора целиком.
  join app.object_terms_v t
    on t.object_id = o.id and t.has_mandate
  where
    (req.budget_min is null or o.price >= req.budget_min)
    and (req.budget_max is null or o.price <= req.budget_max * 1.1)
    and (cardinality(req.zones) = 0 or o.zone = any (req.zones))
    and (cardinality(req.rooms) = 0 or o.rooms = any (req.rooms))
  order by
    (req.budget_max is not null and o.price > req.budget_max),
    -- Своё и своего агентства выше чужого: не потому, что чужое хуже, а
    -- потому, что по своему известно больше и договориться быстрее.
    case app.object_source(t.holder_agent_id, t.agency_id)
      when 'mine' then 0 when 'agency' then 1 else 2 end,
    o.actual_at desc
  limit 100
$$;

revoke execute on function app.matching_objects(uuid) from public;
grant execute on function app.matching_objects(uuid) to authenticated;

comment on function app.matching_objects is
  'Инварианты 20 и 37. Подбор объектов под потребность по всей платформе: тот же тип сделки, бюджет, район, комнаты, действующий договор. Объект чужого агентства участвует наравне — вместе с тем, какой у него договор.';

-- ---------------------------------------------------------------------------
-- Поиск по объектам с источником
-- ---------------------------------------------------------------------------
-- Фильтр СУЖАЕТ уже разрешённое и ничего не открывает: он читает objects под
-- правами вызывающего, а договор — из app.object_terms_v, где денег нет.
-- Пустой параметр — это «любой», а не «никакой»: та же мысль, что в подборе.

create or replace function app.search_objects(
  p_source    text     default null,   -- mine | agency | other | null = все
  p_deal_type deal_type default null,
  p_kind      object_kind default null,
  p_zone      text     default null,
  p_rooms     smallint[] default '{}',
  p_price_min numeric  default null,
  p_price_max numeric  default null,
  p_published boolean  default null,   -- true = только в каталоге
  p_text      text     default null    -- по адресу
) returns table (
    object_id      uuid,
    address        text,
    kind           object_kind,
    deal_type      deal_type,
    zone           text,
    rooms          smallint,
    area           numeric,
    floor          smallint,
    floors_total   smallint,
    price          numeric,
    currency       text,
    actual_at      timestamptz,
    publication_state publication_state,
    photos_count   integer,
    source         text,
    agency_name    text,
    holder_agent_name text,
    has_mandate    boolean,
    mandate_kind   mandate_kind,
    contract_confirmed boolean,
    valid_to       date
  )
  language sql stable security invoker set search_path = public, pg_temp as $$
  select
    o.id, o.address, o.kind, o.deal_type, o.zone, o.rooms, o.area,
    o.floor, o.floors_total, o.price, o.currency::text, o.actual_at,
    o.publication_state,
    (select count(*)::integer from object_photos p where p.object_id = o.id),
    app.object_source(t.holder_agent_id, t.agency_id),
    t.agency_name, t.holder_agent_name,
    t.has_mandate, t.mandate_kind, t.contract_confirmed, t.valid_to
  from objects o
  join app.object_terms_v t on t.object_id = o.id
  where
    (p_source is null
     or app.object_source(t.holder_agent_id, t.agency_id) = p_source)
    and (p_deal_type is null or o.deal_type = p_deal_type)
    and (p_kind      is null or o.kind = p_kind)
    and (nullif(btrim(coalesce(p_zone, '')), '') is null or o.zone = p_zone)
    and (cardinality(coalesce(p_rooms, '{}')) = 0 or o.rooms = any (p_rooms))
    and (p_price_min is null or o.price >= p_price_min)
    and (p_price_max is null or o.price <= p_price_max)
    and (p_published is null
         or (p_published and o.publication_state = 'published')
         or (not p_published and o.publication_state <> 'published'))
    and (nullif(btrim(coalesce(p_text, '')), '') is null
         or o.address ilike '%' || btrim(p_text) || '%')
  order by
    case app.object_source(t.holder_agent_id, t.agency_id)
      when 'mine' then 0 when 'agency' then 1 else 2 end,
    o.actual_at desc nulls last
  limit 300
$$;

comment on function app.search_objects is
  'Инвариант 37. Поиск по объектам платформы с фильтром источника: мои, моего агентства, чужие. Фильтр только сужает — он читает objects правами вызывающего, а договор берёт из app.object_terms_v, где коммерческой тайны нет.';

revoke execute on function app.search_objects(
  text, deal_type, object_kind, text, smallint[], numeric, numeric, boolean, text) from public;
grant execute on function app.search_objects(
  text, deal_type, object_kind, text, smallint[], numeric, numeric, boolean, text) to authenticated;

-- Районы для выпадающего списка: то, что реально есть в базе, а не
-- придуманный справочник, который разойдётся с данными.
create or replace function app.object_zones() returns table (zone text, objects integer)
  language sql stable security invoker set search_path = public, pg_temp as $$
  select o.zone, count(*)::integer
    from objects o
   where o.zone is not null
   group by o.zone
   order by 2 desc, 1
$$;

revoke execute on function app.object_zones() from public;
grant execute on function app.object_zones() to authenticated;

-- ---------------------------------------------------------------------------
-- Воронка объектов — работа СВОЕГО агентства
-- ---------------------------------------------------------------------------
-- Доска «Объекты в работе» отвечает на вопрос «докуда дошла НАША работа».
-- Чужие объекты в ней не работа, а шум: их этапы нам не двигать. Хуже
-- другого: условия договора брались join'ом на mandates, политика которых
-- чужое агентство не показывает, — и чужой объект с подтверждённым
-- эксклюзивом выходил на доске красным «договора нет». Ложная тревога на
-- том самом экране, который для тревоги и заведён.

create or replace view listing_funnel_v
  with (security_invoker = true) as
select
  o.id                       as object_id,
  o.address,
  o.kind,
  o.deal_type,
  o.zone,
  o.rooms,
  o.price,
  o.currency,
  o.publication_state,
  o.actual_at,
  o.owner_stage,
  o.owner_stage_since,
  app.listing_stage(o.id)    as stage,
  md.id                      as mandate_id,
  md.kind                    as mandate_kind,
  md.contract_confirmed,
  md.valid_to,
  md.listing_agent_id,
  a.full_name                as listing_agent_name,
  coalesce(md.listing_agent_id, o.created_by_agent_id) as owner_agent_id,
  coalesce(a.full_name, ca.full_name)                  as owner_agent_name,
  c.name                     as owner_name,
  app.listing_stage_since(o.id) as stage_since,
  extract(day from now() - app.listing_stage_since(o.id))::int as days_in_stage,
  app.listing_stage_days(app.listing_stage(o.id)) as stage_limit_days,
  (app.listing_stage_days(app.listing_stage(o.id)) is not null
   and app.listing_stage_since(o.id)
       < now() - make_interval(days => app.listing_stage_days(app.listing_stage(o.id)))) as stuck,
  (select count(*) from showings s join matches m on m.id = s.match_id
    where m.object_id = o.id and s.status = 'done')::int as showings_done
from objects o
left join mandates md on md.object_id = o.id and md.status = 'active'
left join agents a    on a.id = md.listing_agent_id
left join agents ca   on ca.id = o.created_by_agent_id
left join object_ownerships oo on oo.object_id = o.id and oo.role = 'owner'
left join contacts c  on c.id = oo.contact_id
-- Объект без договора ведёт тот, кто его завёл (инвариант 22) — и граница
-- доски проходит по нему же, иначе чужой черновик остался бы на нашей доске.
-- Поверх политик смотреть не нужно: внутри своего агентства договор и так
-- виден. Мутация «взять договор поверх политик» выжила именно потому, что
-- здесь эти два источника совпадают, а лишний слой это только слой.
where app.same_agency(coalesce(md.listing_agent_id, o.created_by_agent_id))
   or app.is_admin();

comment on view listing_funnel_v is
  'Инварианты 32 и 37. Воронка объектов СВОЕГО агентства: докуда дошла наша работа с собственником. Условия договора берутся поверх политик, чтобы «не вижу договор» не читалось как «договора нет».';
