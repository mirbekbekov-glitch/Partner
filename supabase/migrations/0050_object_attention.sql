-- 0050_object_attention.sql
-- Фильтр «требуют внимания» в поиске по объектам.
--
-- ПОВОД. На сводке есть плитка «N объектов требуют внимания срочно», и она
-- ведёт на /cabinet/objects — то есть на ВЕСЬ список. Агент щёлкает по цифре
-- «1» и остаётся с девятнадцатью строками, ни одна из которых не помечена.
-- Это тот же дефект, что уже ловили с воронкой, только хуже: цифра ведёт
-- куда-то, поэтому выглядит работающей.
--
-- Данные для отчёта есть с миграции 0015: stale_objects_v знает и причины, и
-- степень важности. Не хватало только способа спросить у поиска «покажи
-- именно их». Спецификация продукта просит это прямым текстом, пункт P0.7:
-- «Нужен отчёт „не подтверждались N дней“».
--
-- ТРИ СОСТОЯНИЯ, А НЕ ДВА. Главное решение этой миграции.
--
-- stale_objects_v соединяется с mandates, и права на мандат чужого агентства
-- вызывающему не выданы. Значит для чужого объекта строки не будет — и
-- истолковать это как «с объектом всё в порядке» нельзя: мы просто не знаем.
-- Это ровно та ошибка, которую инвариант 37 нашёл в карточке объекта
-- («пустой ответ политики — не утверждение»), и повторять её здесь незачем.
--
-- Поэтому `attention` возвращает одно из трёх:
--
--   'critical' / 'warning' — знаем, что не так, и насколько;
--   'ok'                   — знаем, что всё в порядке (объект свой или
--                            агентства, строки в отчёте нет);
--   null                   — НЕ ЗНАЕМ: объект чужого агентства, его договор
--                            нам не виден, и судить о его свежести не наше
--                            дело.
--
-- Различие живёт здесь, а не в вёрстке: страница, которой отдали два
-- состояния вместо трёх, нарисует зелёную галочку там, где нужно молчание.

-- Тип возвращаемой таблицы меняется, поэтому замена, а не create or replace.
drop function if exists app.search_objects(
  text, deal_type, object_kind, text, smallint[], numeric, numeric, boolean, text);

create or replace function app.search_objects(
  p_source    text     default null,   -- mine | agency | other | null = все
  p_deal_type deal_type default null,
  p_kind      object_kind default null,
  p_zone      text     default null,
  p_rooms     smallint[] default '{}',
  p_price_min numeric  default null,
  p_price_max numeric  default null,
  p_published boolean  default null,   -- true = только в каталоге
  p_text      text     default null,   -- по адресу
  -- critical | warning | any | null = не фильтровать.
  -- 'any' — «что угодно из отчёта», то есть и срочные, и предупреждения.
  p_attention text     default null
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
    valid_to       date,
    attention      text,
    attention_reasons text[]
  )
  language sql stable security invoker set search_path = public, pg_temp as $$
  select
    o.id, o.address, o.kind, o.deal_type, o.zone, o.rooms, o.area,
    o.floor, o.floors_total, o.price, o.currency::text, o.actual_at,
    o.publication_state,
    (select count(*)::integer from object_photos p where p.object_id = o.id),
    app.object_source(t.holder_agent_id, t.agency_id),
    t.agency_name, t.holder_agent_name,
    t.has_mandate, t.mandate_kind, t.contract_confirmed, t.valid_to,
    case
      when s.severity is not null then s.severity
      -- Чужой объект: договор не виден, судить не можем. См. шапку.
      when app.object_source(t.holder_agent_id, t.agency_id) = 'other' then null
      else 'ok'
    end,
    s.reasons
  from objects o
  join app.object_terms_v t on t.object_id = o.id
  -- Соединение внешнее: объект без строки в отчёте — это норма, а не
  -- причина его спрятать.
  left join stale_objects_v s on s.object_id = o.id
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
    -- Фильтр по вниманию. 'any' означает «есть хоть что-то», а конкретная
    -- степень — ровно её. Пустой параметр не фильтрует: пустое поле это
    -- «любой», а не «никакой».
    and (nullif(btrim(coalesce(p_attention, '')), '') is null
         or (p_attention = 'any' and s.object_id is not null)
         or s.severity = p_attention)
  order by
    -- Срочные наверх, иначе фильтр «любое внимание» показывал бы их
    -- вперемешку с предупреждениями, и глазу не за что зацепиться.
    case s.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
    case app.object_source(t.holder_agent_id, t.agency_id)
      when 'mine' then 0 when 'agency' then 1 else 2 end,
    o.actual_at desc nulls last
  limit 300
$$;

comment on function app.search_objects is
  'Инварианты 37 и отчёт 0015. Поиск по объектам платформы: источник (мои, агентства, чужие) и внимание (срочно, предупреждение, любое). Поле attention имеет ТРИ состояния: степень, ok и null — последнее означает «не знаем», потому что договор чужого агентства не виден, и выдавать это за «всё в порядке» нельзя.';

revoke execute on function app.search_objects(
  text, deal_type, object_kind, text, smallint[], numeric, numeric, boolean, text, text) from public;
grant execute on function app.search_objects(
  text, deal_type, object_kind, text, smallint[], numeric, numeric, boolean, text, text) to authenticated;
