-- ИНВАРИАНТ 34. У агента есть направления и своя работа; у руководителя —
--               всё агентство.
--
--   а. Направление — набор, а не отдел: агент ведёт аренду, продажу или
--      оба. Работу чужого направления он не видит.
--   б. Работа личная: агент видит ту, в которой участвует.
--   в. Руководитель видит всё своё агентство — и только своё.
--   г. Участие важнее принадлежности: сторона совместной сделки видит её,
--      даже если клиент чужой.
--   д. Направления назначает руководитель, и пустой набор запрещён.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Руководитель и агент аренды
-- ---------------------------------------------------------------------------
set role postgres;
set request.jwt.claims = '{}';

-- Айбек становится руководителем агентства, Чынгыз — агентом только аренды.
update agents set role = 'head' where id = :'agent_aibek';
update agents set directions = '{rent}' where id = :'agent_chyngyz';

set role authenticated;

-- ===========================================================================
-- 34а. Чужое направление не видно
-- ===========================================================================
-- Клиенты сценария приёмки — на покупку. Для агента аренды их нет.

set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select array_to_string(app.my_directions(), ',')), 'rent',
  'у Чынгыза одно направление');
select test.ok(not app.in_my_directions('sale'), 'продажа — не его');
select test.ok(app.in_my_directions('rent'), 'аренда — его');

select test.eq(
  test.visible_count($$select 1 from requirements where deal_type = 'sale'$$),
  0::bigint,
  'клиентов на покупку агент аренды не видит вовсе');

-- Проверка не вакуумная: у его коллег такие клиенты есть.
set request.jwt.claims = :'claims_bakyt';
select test.ok(
  test.visible_count($$select 1 from requirements where deal_type = 'sale'$$) > 0,
  'а у агента продажи они есть');

-- ===========================================================================
-- 34б. Работа личная
-- ===========================================================================
-- До этого инварианта агент видел работу всех коллег агентства.

set request.jwt.claims = :'claims_bakyt';
select * from create_requirement('sale'::deal_type, null, 'Клиент Бакыта 2',
         '0555 340 001', 50000, 70000, '{Юг}', '{1}'::smallint[]) \gset bk_

-- Второй агент продажи, которому этот клиент не принадлежит.
set role postgres;
set request.jwt.claims = '{}';
insert into agents (id, email, phone, auth_user_id, full_name, role, status, directions)
values ('00000000-0000-0000-0000-0000000000f2', 'sales2@partner.kg', '+996700340002',
        '00000000-0000-0000-0000-0000000000e2', 'Второй продажник', 'agent', 'approved',
        '{sale}');
\set claims_sales2 '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}'

set role authenticated;
set request.jwt.claims = :'claims_sales2';
select test.eq(
  test.visible_count(format($$select 1 from requirements where id = %L$$, :'bk_id')),
  0::bigint,
  'клиента коллеги по тому же направлению агент не видит');

-- ===========================================================================
-- 34в. Руководитель видит всё агентство
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
select test.ok(app.is_head(), 'Айбек — руководитель');
select test.eq(
  test.visible_count(format($$select 1 from requirements where id = %L$$, :'bk_id')),
  1::bigint,
  'руководитель видит клиента любого своего агента');

-- Но не чужого агентства.
set role postgres;
set request.jwt.claims = '{}';
insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa03', 'Соседнее агентство');
insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id)
values ('00000000-0000-0000-0000-0000000000f3', 'neighbour@partner.kg', '+996700340003',
        '00000000-0000-0000-0000-0000000000e3', 'Сосед', 'agent', 'approved',
        '00000000-0000-0000-0000-00000000aa03');
\set claims_neighbour '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}'

set role authenticated;
set request.jwt.claims = :'claims_neighbour';
select * from create_requirement('sale'::deal_type, null, 'Клиент Соседа',
         '0555 340 004', 40000, 60000, '{Север}', '{1}'::smallint[]) \gset nb_

set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format($$select 1 from requirements where id = %L$$, :'nb_id')),
  0::bigint,
  'руководитель НЕ видит клиента чужого агентства: он руководитель, а не администратор');

-- ===========================================================================
-- 34г. Участие важнее принадлежности
-- ===========================================================================
-- Без этого совместная сделка двух агентств перестала бы вестись в тот же
-- день: сторона не видела бы клиента противоположной стороны.

set request.jwt.claims = :'claims_neighbour';
select * from create_match(:'obj1', :'nb_id') \gset nm_
select * from create_deal_from_match(:'nm_id') \gset nd_

set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format($$select 1 from deals where id = %L$$, :'nd_id')),
  1::bigint,
  'сторона совместной сделки видит её');
select test.eq(
  test.visible_count(format($$select 1 from requirements where id = %L$$, :'nb_id')),
  1::bigint,
  'и клиента противоположной стороны — пока сделка жива');

-- ===========================================================================
-- 34д. Направления назначает руководитель
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select set_agent_directions(%L, '{sale,rent}')$$, :'agent_chyngyz'),
  'INVARIANT_34',
  'рядовой агент направления не раздаёт');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select array_to_string(directions, ',')
     from set_agent_directions(:'agent_chyngyz', '{sale,rent}')),
  'sale,rent',
  'руководитель добавил Чынгызу продажу');

-- Пустой набор — это увольнение, а не настройка.
select test.throws(
  format($$select set_agent_directions(%L, '{}'::deal_type[])$$, :'agent_chyngyz'),
  'INVARIANT_34',
  'без направлений агента не оставить');

-- Чужим агентством руководитель не распоряжается.
select test.throws(
  format($$select set_agent_directions(%L, '{rent}')$$,
         '00000000-0000-0000-0000-0000000000f3'),
  'INVARIANT_34',
  'агента чужого агентства руководитель не трогает');

-- И теперь Чынгыз видит продажу: направления заработали сразу.
set request.jwt.claims = :'claims_chyngyz';
select test.ok(
  test.visible_count($$select 1 from requirements where deal_type = 'sale'$$) = 0,
  'но чужих клиентов на продажу он всё равно не видит: направление — не доступ');

-- ===========================================================================
-- 34е. Сводка руководителя
-- ===========================================================================
-- «Могу включить фильтр, у кого сколько объектов на каких стадиях».

set request.jwt.claims = :'claims_aibek';
select test.ok(
  (select count(*) from agency_workload_v) > 0,
  'руководитель видит загрузку агентства по стадиям');

set request.jwt.claims = :'claims_neighbour';
select test.eq(
  (select count(*) from agency_workload_v
    where agent_id in (select id from agents where agency_id = '00000000-0000-0000-0000-00000000aa01')),
  0::bigint,
  'а чужую загрузку — нет');

select test.ok(
  not has_table_privilege('anon', 'agency_workload_v', 'select'),
  'анониму сводка загрузки не выдана');

-- ===========================================================================
-- 34ж. Руководитель, которого ещё не одобрили, — не руководитель
-- ===========================================================================
-- Роль можно записать в строку агента до одобрения (переносом, ошибкой
-- администратора). Пока агент не одобрен, он не руководитель и не видит
-- ничего: то же условие, что у app.current_agent_id().

set role postgres;
set request.jwt.claims = '{}';
update agents set role = 'head' where id = '00000000-0000-0000-0000-0000000000a4';

set role authenticated;
set request.jwt.claims = :'claims_pending';
select test.ok(not app.is_head(), 'ждущий одобрения не руководитель, даже с ролью');
select test.eq(
  test.visible_count('select 1 from requirements'), 0::bigint,
  'и клиентов агентства он не видит');
