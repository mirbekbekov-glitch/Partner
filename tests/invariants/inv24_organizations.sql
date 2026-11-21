-- ОРГАНИЗАЦИЯ. Агент состоит в агентстве недвижимости или работает сам.
--
-- Два правила, ради которых сущность вообще заведена:
--   • название уникально по нормализованному виду — иначе «Этажи» и
--     «этажи» станут разными агентствами;
--   • агент ЗАЯВЛЯЕТ агентство, но подтвердить принадлежность может только
--     админ — иначе любой прикроется чужой репутацией.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Агент заявляет агентство
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select * from set_my_organization('Этажи'::text) \gset a1_
reset role; reset request.jwt.claims;

select test.ok(:'a1_organization_id' is not null, 'агентство записано агенту');
select test.eq((select name from organizations where id = :'a1_organization_id'), 'Этажи',
  'название сохранено как ввели');
select test.eq(:'a1_org_confirmed'::text, 'f',
  'принадлежность НЕ подтверждена: заявление не равно подтверждению');

-- ===========================================================================
-- Названия не плодятся от регистра и пробелов
-- ===========================================================================
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from set_my_organization('  ЭТАЖИ  '::text) \gset a2_
reset role; reset request.jwt.claims;

select test.eq(:'a2_organization_id'::text, :'a1_organization_id',
  '«ЭТАЖИ» с пробелами — то же агентство, а не второе');
select test.eq((select count(*)::int from organizations), 1,
  'агентство в базе одно');

-- Прямая вставка дубля тоже отбита — правило в схеме, а не в функции.
select test.throws(
  $$insert into organizations (name) values ('этажи')$$,
  'organizations_name_key',
  'дубликат по нормализованному названию отклонён схемой');

-- ===========================================================================
-- Подтверждение: только админ
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  format($$select confirm_agent_organization(%L, true)$$, :'agent_aibek'),
  'FORBIDDEN',
  'агент не подтверждает собственную принадлежность');
-- И в обход функции — тоже: правило живёт в триггере.
select test.throws(
  format($$update agents set org_confirmed = true where id = %L$$, :'agent_aibek'),
  'permission denied',
  'прямой UPDATE агенту не выдан вовсе');
reset role; reset request.jwt.claims;

-- Даже владельцем таблиц, но с удостоверением агента, подтверждение не
-- проходит: триггер смотрит на того, кто в сессии, а не на права.
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format($$update agents set org_confirmed = true where id = %L$$, :'agent_aibek'),
  'FORBIDDEN: подтвердить принадлежность',
  'триггер ловит подтверждение мимо функции');
reset request.jwt.claims;

set request.jwt.claims = :'claims_admin';
set role authenticated;
select * from confirm_agent_organization(:'agent_aibek', true) \gset c1_
reset role; reset request.jwt.claims;
select test.eq(:'c1_org_confirmed'::text, 't', 'админ подтвердил принадлежность');

-- ===========================================================================
-- Смена агентства сбрасывает подтверждение
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select * from set_my_organization('Дом Плюс'::text) \gset a3_
reset role; reset request.jwt.claims;
select test.eq(:'a3_org_confirmed'::text, 'f',
  'подтверждение снято: подтверждали прежнее агентство, а не это');
select test.ok(:'a3_organization_id'::text <> :'a1_organization_id',
  'агент переехал в другое агентство');

-- ===========================================================================
-- Частный агент — это ОТСУТСТВИЕ организации
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select clear_my_organization() is not null as cleared \gset
reset role; reset request.jwt.claims;
-- Читаем из таблицы, а не из \gset: при NULL он сбрасывает переменную, и
-- ссылка на неё остаётся в запросе буквально. Та же ловушка описана в inv6.
select test.ok((select organization_id is null from agents where id = :'agent_aibek'),
  'частный агент: связь снята');
select test.ok((select not org_confirmed from agents where id = :'agent_aibek'),
  'и подтверждение снято вместе с ней');
select test.eq((select count(*)::int from organizations where name_normalized = 'частный агент'), 0,
  'пустышка «Частный агент» не заводится');

-- ===========================================================================
-- Чужое не тронуть
-- ===========================================================================
-- Функция не принимает идентификатор агента вовсе, поэтому задеть коллегу
-- нечем. Проверяем, что у Бакыта всё на месте после чужих действий.
select test.ok((select organization_id is not null from agents where id = :'agent_bakyt'),
  'агентство коллеги осталось нетронутым');

-- Переименование — только админ.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.throws(
  format($$select rename_organization(%L, 'Чужое имя')$$,
         (select organization_id from agents where id = '00000000-0000-0000-0000-0000000000a2')),
  'FORBIDDEN',
  'переименовать агентство рядовой агент не может');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- Что видно и кому
-- ===========================================================================
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.ok(test.visible_count($$select 1 from organizations$$) > 0,
  'список агентств виден любому вошедшему: без него не выбрать своё');
select test.throws(
  $$insert into organizations (name) values ('Самозванец')$$,
  'permission denied for table organizations',
  'агент не заводит агентство напрямую, мимо функции');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws(
  $$select count(*) from organizations$$,
  'permission denied for table organizations',
  'анониму список агентств не выдан');
select test.throws(
  $$select set_my_organization('Этажи')$$,
  'permission denied for function set_my_organization',
  'анониму не выдан даже вызов');
reset role;

-- ===========================================================================
-- Инвариант 7
-- ===========================================================================
select test.ok(
  exists (select 1 from audit_log where entity_type = 'organization' and action = 'insert'),
  'появление агентства записано в журнал');
select test.ok(
  exists (select 1 from audit_log where entity_type = 'agent' and action = 'update'
            and diff ? 'organization_id'),
  'смена агентства у агента записана в журнал');
