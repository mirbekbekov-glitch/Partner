-- ИНВАРИАНТ 37. Объект чужого агентства — рабочий объект.
--
--   а. Подбор находит объект чужого агентства наравне со своим: «договор не
--      виден мне» — это не «договора нет».
--   б. Вместе с чужим объектом видны условия его договора: тип, подписан ли,
--      чьё агентство. Денег не видно никаких.
--   в. Источник выводится из того, кто ведёт объект: мой, моего агентства,
--      чужой. Три значения, и они не пересекаются.
--   г. Фильтр только СУЖАЕТ: источником нельзя открыть то, что закрыто
--      политиками.
--   д. Воронка объектов — работа своего агентства: чужого объекта там нет,
--      и ложной тревоги «договора нет» по нему тоже.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Второе агентство с настоящим объектом
-- ---------------------------------------------------------------------------
-- Без чужого объекта все проверки ниже вакуумные: «чужих не видно» проходит
-- на данных, где чужих нет.
set role postgres;
set request.jwt.claims = '{}';

insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa02', 'Альфа');

insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id, directions)
values ('00000000-0000-0000-0000-0000000000f1', 'nurlan@alfa.kg', '+996700900011',
        '00000000-0000-0000-0000-0000000000e1', 'Нурлан', 'agent', 'approved',
        '00000000-0000-0000-0000-00000000aa02', '{sale}');

\set claims_alfa '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}'
\set agent_alfa  '00000000-0000-0000-0000-0000000000f1'
\set obj_alfa    '00000000-0000-0000-0000-0000000f0001'

insert into contacts (id, kind, name, owner_agent_id, roles, source) values
  ('00000000-0000-0000-0000-00000000c0a1', 'person', 'Собственник Альфы',
   :'agent_alfa', '{owner}', 'чужое агентство');

insert into objects (id, kind, deal_type, address, zone, rooms, area, floor, price,
                     created_by_agent_id)
values (:'obj_alfa', 'flat', 'sale', 'Жибек Жолу 100, кв. 3', 'Центр', 2, 60.0, 4, 90000,
        :'agent_alfa');

insert into object_ownerships (object_id, contact_id, role, share) values
  (:'obj_alfa', '00000000-0000-0000-0000-00000000c0a1', 'owner', 1);

insert into mandates (object_id, kind, valid_from, valid_to, start_price,
                      listing_agent_id, contract_confirmed, status)
values (:'obj_alfa', 'exclusive', current_date - 10, current_date + 80, 95000,
        :'agent_alfa', true, 'active');

update objects set publication_state = 'published' where id = :'obj_alfa';

-- Объект чужого агентства БЕЗ договора: он не должен попадать в подбор по
-- инварианту 20, и причина отказа должна быть именно отсутствие договора,
-- а не чужое агентство.
\set obj_alfa_nc '00000000-0000-0000-0000-0000000f0002'
insert into objects (id, kind, deal_type, address, zone, rooms, area, floor, price,
                     created_by_agent_id)
values (:'obj_alfa_nc', 'flat', 'sale', 'Байтик Баатыра 5, кв. 1', 'Центр', 2, 55.0, 2, 88000,
        :'agent_alfa');

-- Аренда. Без неё «фильтр сделки совпадает» сравнивал ноль с нулём: в
-- сценарии приёмки одни продажи, и проверка фильтра ничего не проверяла.
\set obj_rent '00000000-0000-0000-0000-0000000f0003'
insert into objects (id, kind, deal_type, address, zone, rooms, area, floor, price,
                     created_by_agent_id)
values (:'obj_rent', 'flat', 'rent', 'Московская 70, кв. 9', 'Юг', 1, 38.0, 6, 400,
        :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share) values
  (:'obj_rent', :'contact_owner', 'owner', 1);
insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_rent', 'non_exclusive', current_date - 5, 400, :'agent_aibek', true, 'active');

-- Свой объект БЕЗ договора. Он и есть та колонка, ради которой воронка
-- объектов заведена, и граница доски обязана проходить по заведшему, а не
-- по владельцу договора: договора-то нет. Без этой строки мутация «считать
-- своими только объекты с нашим договором» проходила незамеченной — своя
-- работа до договора просто исчезала с доски.
\set obj_draft '00000000-0000-0000-0000-0000000f0004'
insert into objects (id, kind, deal_type, address, zone, rooms, area, floor, price,
                     created_by_agent_id)
values (:'obj_draft', 'flat', 'sale', 'Табышалиева 12, кв. 7', 'Центр', 2, 50.0, 2, 70000,
        :'agent_bakyt');

-- ===========================================================================
-- 37а. Подбор достаёт чужой объект
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.eq(
  (select count(*) from app.matching_objects(:'req1')
    where object_id = :'obj_alfa')::int, 1,
  'подбор находит объект чужого агентства');

select test.eq(
  (select count(*) from app.matching_objects(:'req1')
    where object_id = :'obj_alfa_nc')::int, 0,
  'объект чужого агентства без договора в подбор не идёт');

select test.eq(
  (select source from app.matching_objects(:'req1') where object_id = :'obj_alfa'),
  'other',
  'источник чужого объекта в подборе назван');

select test.ok(
  (select count(distinct source) from app.matching_objects(:'req1')) >= 2,
  'в одном подборе встречаются объекты разных источников');

-- Своё выше чужого: не потому, что чужое хуже, а потому, что по своему
-- известно больше. Порядок — часть ответа, а не украшение.
select test.ok(
  (select min(n) from (select row_number() over () as n, source
                         from app.matching_objects(:'req1')) t where source = 'other')
  >
  (select max(n) from (select row_number() over () as n, source
                         from app.matching_objects(:'req1')) t
    where source in ('mine', 'agency')
      and (select count(*) from app.matching_objects(:'req1') where source = 'other') > 0),
  'чужие объекты идут после своих');

-- ===========================================================================
-- 37б. Условия чужого договора видны, деньги — нет
-- ===========================================================================
select test.eq(
  (select mandate_kind::text from app.matching_objects(:'req1') where object_id = :'obj_alfa'),
  'exclusive',
  'тип договора чужого объекта виден в подборе');

select test.eq(
  (select contract_confirmed from app.matching_objects(:'req1') where object_id = :'obj_alfa'),
  true,
  '«договор подписан» по чужому объекту видно');

select test.eq(
  (select agency_name from app.matching_objects(:'req1') where object_id = :'obj_alfa'),
  'Альфа',
  'видно, чьё агентство ведёт чужой объект');

select test.eq(
  (select mandate_kind::text from listing_terms_v where object_id = :'obj_alfa'),
  'exclusive',
  'listing_terms_v работает через границу агентства');

select test.eq(
  (select mine from listing_terms_v where object_id = :'obj_alfa'), false,
  'чужой объект в listing_terms_v помечен как чужой');

-- Денег нет нигде: ни в представлении договоров, ни в поиске, ни в подборе.
select test.eq(
  (select count(*)::int from information_schema.columns
    where table_schema = 'app' and table_name = 'object_terms_v'
      and column_name in ('start_price', 'commission_rule', 'closing_share_ratio')),
  0,
  'в условиях чужого договора нет ни стартовой цены, ни правила комиссии, ни доли');

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'listing_terms_v'
      and column_name in ('start_price', 'commission_rule', 'closing_share_ratio')),
  0,
  'и в listing_terms_v их тоже нет');

select test.eq(
  test.visible_count('select 1 from mandates where object_id = ''' || :'obj_alfa' || ''''),
  0::bigint,
  'сама таблица договоров чужое агентство по-прежнему не показывает');

-- Карточка объекта. Она читает те же условия, что список, и по чужому
-- объекту обязана говорить то же самое. До этой миграции карточка писала
-- «нет действующего договора» там, где договор есть и подтверждён: пустой
-- join на mandates превращался в утверждение, и утверждение было ложным.
select test.eq(
  (select has_mandate from app.object_terms_v where object_id = :'obj_alfa'), true,
  'карточка чужого объекта знает, что договор есть');

select test.eq(
  (select mandate_kind::text from app.object_terms_v where object_id = :'obj_alfa'),
  'exclusive',
  'и какой именно');

select test.eq(
  (select agency_name from app.object_terms_v where object_id = :'obj_alfa'), 'Альфа',
  'и чьё агентство его ведёт');

select test.eq(
  (select has_mandate from app.object_terms_v where object_id = :'obj_alfa_nc'), false,
  'а по чужому объекту без договора говорит «договора нет» — и это правда');

-- ===========================================================================
-- 37в. Три источника, и они не пересекаются
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';

select test.eq(
  (select source from app.search_objects() where object_id = :'obj1'), 'mine',
  'объект, который веду я, — «мой»');

set request.jwt.claims = :'claims_bakyt';

select test.eq(
  (select source from app.search_objects() where object_id = :'obj1'), 'agency',
  'тот же объект для коллеги — «моего агентства»');

select test.eq(
  (select source from app.search_objects() where object_id = :'obj_alfa'), 'other',
  'объект Альфы — «другого агентства»');

select test.eq(
  (select count(*)::int from app.search_objects()),
  (select count(*)::int from app.search_objects('mine'))
  + (select count(*)::int from app.search_objects('agency'))
  + (select count(*)::int from app.search_objects('other')),
  'три источника в сумме дают всё и ничего не считают дважды');

-- Объект без договора ведёт тот, кто его завёл (инвариант 22) — источник
-- берётся оттуда же, иначе чужой черновик оказался бы ничьим.
select test.eq(
  (select source from app.search_objects() where object_id = :'obj_alfa_nc'), 'other',
  'чужой объект без договора тоже чужой: источник берётся от заведшего');

-- ===========================================================================
-- 37г. Фильтр только сужает
-- ===========================================================================
-- Поиск читает objects правами вызывающего. Если бы он смотрел поверх
-- политик «за компанию» с договором, он стал бы дырой в тот же день.

select test.ok(
  (select count(*) from app.search_objects('other'))
  <= (select count(*) from app.search_objects()),
  'выбор источника не добавляет строк');

select test.eq(
  (select count(*)::int from app.search_objects(null, 'rent')),
  (select count(*)::int from app.search_objects() where deal_type = 'rent'),
  'фильтр сделки совпадает с отбором по тому же полю');

select test.eq(
  (select count(*)::int from app.search_objects(null, 'rent')), 1,
  'и отбирает именно аренду, а не пустоту');

select test.eq(
  (select count(*)::int from app.search_objects(null, null, 'house')), 1,
  'фильтр типа объекта отбирает дом');

select test.eq(
  (select count(*)::int from app.search_objects(null, null, null, null, '{2}'::smallint[])),
  (select count(*)::int from app.search_objects() where rooms = 2),
  'фильтр комнат совпадает с отбором по тому же полю');

select test.ok(
  (select count(*) from app.search_objects(null, null, null, null, '{2}'::smallint[])) > 0,
  'и двухкомнатные действительно находятся');

select test.eq(
  (select count(*)::int from app.search_objects(null, null, null, 'Центр')),
  (select count(*)::int from app.search_objects() where zone = 'Центр'),
  'фильтр района совпадает с отбором по тому же полю');

select test.eq(
  (select count(*)::int from app.search_objects(null, null, null, null, '{}', 80000, 100000)),
  (select count(*)::int from app.search_objects() where price between 80000 and 100000),
  'вилка цены совпадает с отбором по тому же полю');

-- Пустой параметр — «любой», а не «никакой». Первая версия подбора на этом
-- уже спотыкалась: пустой список районов означал, что не подходит ничего.
select test.eq(
  (select count(*)::int from app.search_objects(null, null, null, '', '{}')),
  (select count(*)::int from app.search_objects()),
  'пустой район — это «любой», а не «никакой»');

select test.eq(
  (select count(*)::int from app.search_objects(null, null, null, null, '{}'::smallint[])),
  (select count(*)::int from app.search_objects()),
  'пустой список комнат — это «любой»');

select test.eq(
  (select count(*)::int from app.search_objects(null,null,null,null,'{}',null,null,true)),
  (select count(*)::int from app.search_objects() where publication_state = 'published'),
  '«только в каталоге» отбирает опубликованные');

select test.eq(
  (select count(*)::int from app.search_objects(null,null,null,null,'{}',null,null,null,'Жибек')),
  1,
  'поиск по адресу находит объект чужого агентства');

-- Ждущий одобрения не получает ни источника, ни поиска: агентства у него нет.
set request.jwt.claims = :'claims_pending';
select test.eq(
  (select count(*)::int from app.search_objects('agency')), 0,
  'неодобренному «моё агентство» не возвращает ничего');

-- ===========================================================================
-- 37д. Воронка объектов — работа своего агентства
-- ===========================================================================
-- Раньше чужой объект попадал на доску, а условия его договора брались
-- join'ом на mandates — и подтверждённый эксклюзив Альфы выходил на нашей
-- доске красным «договора нет». Ложная тревога на экране, заведённом ради
-- тревоги, хуже отсутствия экрана.
set request.jwt.claims = :'claims_bakyt';

select test.eq(
  (select count(*)::int from listing_funnel_v where object_id = :'obj_alfa'), 0,
  'чужого объекта на доске «Объекты в работе» нет');

select test.ok(
  (select count(*) from listing_funnel_v) > 0,
  'а своя работа на доске осталась');

select test.eq(
  (select count(*)::int from listing_funnel_v lf
     join app.object_terms_v t on t.object_id = lf.object_id
    where t.agency_id is distinct from app.current_agency_id()),
  0,
  'на доске нет ни одного объекта чужого агентства');

-- Внутри своего агентства «нет договора» по-прежнему говорится честно.
select test.eq(
  (select stage from listing_funnel_v where object_id = :'obj3'), 'no_contract',
  'свой объект с неподтверждённым договором остаётся в колонке «Без договора»');

select test.eq(
  (select stage from listing_funnel_v where object_id = :'obj_draft'), 'new',
  'свой объект ДО договора на доске есть: его ведёт заведший');

select test.eq(
  (select owner_agent_id from listing_funnel_v where object_id = :'obj_draft'),
  :'agent_bakyt'::uuid,
  'и ведёт его именно тот, кто завёл');

set role postgres;
set request.jwt.claims = '{}';
