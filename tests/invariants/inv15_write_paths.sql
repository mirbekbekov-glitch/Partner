-- Обходы прямой записью в таблицы (миграция 0018).
--
-- Регрессия на пять дыр, найденных сквозным разбором слоя доступа. Все они
-- были НЕ в функциях, а в том, что PostgREST отдаёт таблицы напрямую, а
-- политики ограничивают только набор строк, но не набор колонок.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
select * from create_deal_from_match(:'m_id') \gset d_
select * from close_deal(:'d_id', 100000) \gset c_
reset role;

select test.eq(:'c_commission_total'::numeric, 2000.00::numeric, 'комиссия посчитана');
select test.eq(:'c_closing_share'::numeric, 1000.00::numeric, 'доли поровну');

-- ===========================================================================
-- A. Деньги сделки переписать нельзя
-- ===========================================================================
-- Было: closing-агент выставлял себе listing=1, closing=99999 из 100000.

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select test.throws(
  format($$update deals set closing_share = 99999 where id = %L$$, :'d_id'),
  'permission denied',
  'сторона сделки не может писать в deals: грант снят');

select test.throws(
  format($$insert into deals (match_id, object_id, requirement_id, mandate_id,
                              listing_agent_id, closing_agent_id)
           values (%L, %L, %L, %L, %L, %L)$$,
          :'m_id', :'obj1', :'req1', :'mandate1', :'agent_aibek', :'agent_bakyt'),
  'permission denied',
  'и вставить сделку мимо функции тоже');

select test.throws(
  format($$delete from deals where id = %L$$, :'d_id'),
  'permission denied',
  'и удалить сделку нельзя');
reset role;

select test.eq((select closing_share from deals where id = :'d_id'), 1000.00::numeric,
  'доли остались как посчитала база');

-- Даже владельцем таблиц суммы закрытой сделки не переписываются.
select test.throws(
  format($$update deals set commission_total = 1 where id = %L$$, :'d_id'),
  'INVARIANT_3',
  'триггер держит суммы и при обходе грантов');
select test.throws(
  format($$update deals set final_price = 1 where id = %L$$, :'d_id'),
  'INVARIANT_3',
  'и финальную цену закрытой сделки');

-- При этом законный путь работает: этапы ведёт функция.
-- req1 закрыта этой же сделкой (инвариант 2), поэтому берём свежую
-- потребность: по закрытой подбор невозможен, и это правильно.
insert into requirements (id, contact_id, deal_type, budget_max, agent_id, status)
values ('00000000-0000-0000-0000-0000000fe001', :'contact_client', 'sale', 200000,
        :'agent_bakyt', 'qualified');
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj2', '00000000-0000-0000-0000-0000000fe001') \gset m3_
select * from create_deal_from_match(:'m3_id') \gset d3_
select test.eq((set_deal_status(:'d3_id', 'documents'::deal_status)).status,
  'documents'::deal_status, 'законный путь ведения сделки работает');
reset role;

-- ===========================================================================
-- B. closing-агент подбора присвоить нельзя
-- ===========================================================================
-- Было: автор подбора ставил себя closing-агентом прямым UPDATE.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select * from create_match(:'obj3', :'req2') \gset cm_
select test.eq(:'cm_closing_agent_id'::text, :'agent_bakyt'::text,
  'closing-агент взят из потребности');

select test.throws(
  format($$update matches set closing_agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'cm_id'),
  'permission denied',
  'колонка closing_agent_id агенту не выдана');

-- И вставить подбор с подменённым closing-агентом тоже нельзя.
select test.throws(
  format($$insert into matches (object_id, requirement_id, closing_agent_id,
                                created_by_agent_id)
           values (%L, %L, %L, %L)$$,
          :'obj1', :'req2', :'agent_chyngyz', :'agent_chyngyz'),
  'INVARIANT_3',
  'вставка подбора с чужим closing-агентом отбита триггером');
reset role;

-- Триггер держит правило и в обход грантов.
select test.throws(
  format($$update matches set closing_agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'cm_id'),
  'INVARIANT_3',
  'триггер держит closing-агента и владельцем таблиц');

select test.eq((select closing_agent_id from matches where id = :'cm_id')::text,
  :'agent_bakyt'::text, 'closing-агент не изменился');

-- ===========================================================================
-- C. Потребность в «в сделке» без сделки
-- ===========================================================================

select test.throws(
  format($$update requirements set status = 'in_deal' where id = %L$$, :'req2'),
  'INVARIANT_2',
  'потребность в «в сделке» без сделки отбита триггером');

select test.eq((select status from requirements where id = :'req2'),
  'qualified'::requirement_status, 'статус потребности не изменился');

-- И обратное: пока сделка жива, потребность из «в сделке» не уводят.
select test.throws(
  $$update requirements set status = 'qualified'
     where id = '00000000-0000-0000-0000-0000000fe001'$$,
  'идёт сделка',
  'потребность с живой сделкой в другой статус не переводится');

-- ===========================================================================
-- D. Чужому объекту нельзя подставить собственника
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
insert into contacts (id, name, owner_agent_id)
values ('00000000-0000-0000-0000-00000000cc99', 'Подставной', :'agent_chyngyz');

-- obj1 завёл Айбек, активный мандат тоже его — Чынгыз к объекту отношения
-- не имеет. На INSERT политика бросает ошибку (в отличие от UPDATE, который
-- молча не находит строку), поэтому здесь ждём отказ.
select test.throws(
  format($$insert into object_ownerships (object_id, contact_id, role, share)
           values (%L, '00000000-0000-0000-0000-00000000cc99', 'co_owner', 0.5)$$, :'obj1'),
  'row-level security',
  'привязать свой контакт к чужому объекту нельзя');
reset role;

select test.eq((select count(*)::int from object_ownerships where object_id = :'obj1'), 1,
  'у чужого объекта собственник не появился');
select test.eq(
  (select count(*)::int from object_ownerships
    where contact_id = '00000000-0000-0000-0000-00000000cc99'), 0,
  'подставной контакт ни к чему не привязан');

-- А к своему объекту — пожалуйста.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select * from create_object(
  p_kind => 'flat', p_deal_type => 'sale', p_address => 'Свой объект', p_price => 50000
) \gset co_
insert into object_ownerships (object_id, contact_id, role, share)
values (:'co_id', '00000000-0000-0000-0000-00000000cc99', 'owner', 1);
select test.eq(
  (select count(*)::int from object_ownerships where object_id = :'co_id'), 1,
  'к своему объекту собственник привязывается');
reset role;

-- ===========================================================================
-- E. Каналы чужого объекта
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.throws(
  format($$insert into publication_channels (object_id, channel, status, external_id)
           values (%L, 'lalafo', 'exported', 'подделка-123')$$, :'obj2'),
  'row-level security',
  'в каналы чужого объекта запись не прошла');
reset role;

select test.eq((select count(*)::int from publication_channels where object_id = :'obj2'), 0,
  'каналов у чужого объекта не появилось');

-- Снять чужой объект с площадок тоже нельзя.
insert into publication_channels (object_id, channel, status)
values (:'obj2', 'site', 'exported');

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
update publication_channels set status = 'withdrawn' where object_id = :'obj2';
reset role;
select test.eq((select status from publication_channels
                 where object_id = :'obj2' and channel = 'site'),
  'exported'::channel_status, 'чужой объект с площадки не снят');

-- Свой — можно.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
update publication_channels set status = 'withdrawn' where object_id = :'obj2';
reset role;
select test.eq((select status from publication_channels
                 where object_id = :'obj2' and channel = 'site'),
  'withdrawn'::channel_status, 'listing-агент снимает свой объект с площадки');

-- ===========================================================================
-- Структурные поля: мандат и объект
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;

select test.throws(
  format($$update mandates set object_id = %L where id = %L$$, :'obj3', :'mandate1'),
  'permission denied',
  'мандат нельзя переподвязать к другому объекту');
select test.throws(
  format($$update mandates set listing_agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'mandate1'),
  'permission denied',
  'мандат нельзя переписать на другого listing-агента');

select test.throws(
  format($$update objects set published_at = '2000-01-01' where id = %L$$, :'obj1'),
  'permission denied',
  'published_at агенту не выдан: им распоряжается триггер инварианта 5');

select test.throws(
  format($$update requirements set agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'req2'),
  'permission denied',
  'потребность нельзя тихо передать другому агенту');
select test.throws(
  format($$update contacts set owner_agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'contact_owner'),
  'permission denied',
  'контакт нельзя тихо передать другому агенту');

-- Содержательные поля при этом правятся свободно.
update objects set price = 86000 where id = :'obj1';
select test.ok(true, 'цену объекта агент правит');
update mandates set contract_confirmed = true where id = :'mandate1';
select test.ok(true, 'подтверждение договора агент ставит');
reset role;

-- ===========================================================================
-- Структурная проверка: ни одно представление не обходит RLS
-- ===========================================================================
-- Представление без security_invoker выполняется от ВЛАДЕЛЬЦА и RLS не
-- применяет — то есть отдаёт всё. Это не ошибка в запросе, её не видно при
-- чтении кода страницы, и инвариант 4 обходится целиком. Поэтому проверяем
-- структурно: новое представление без этой опции обязано ронять прогон.

select test.eq(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
      and coalesce((select option_value from pg_options_to_table(c.reloptions)
                     where option_name = 'security_invoker'), 'false') <> 'true'),
  0, 'у всех представлений в public включён security_invoker');

-- И анониму выдана только витрина каталога и справочник районов: всё
-- остальное — агентам. Районы появились в этом списке вместе с публичной
-- формой заявки (0031): выбрать район из списка нужно до входа, а сам
-- список не содержит ничего, кроме названий.
select test.eq(
  (select string_agg(table_name, ', ' order by table_name)
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'),
  'districts, objects, public_catalog_v',
  'анониму выданы только витрина каталога, объекты под её политикой и справочник районов');

-- ===========================================================================
-- Подбор: тип сделки сходится и при прямой вставке
-- ===========================================================================
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000ff001', 'flat', 'rent', 'Аренда', 500, :'agent_aibek');

select test.throws(
  format($$insert into matches (object_id, requirement_id, closing_agent_id,
                                created_by_agent_id)
           values ('00000000-0000-0000-0000-0000000ff001', %L, %L, %L)$$,
         :'req2', :'agent_bakyt', :'agent_bakyt'),
  'подбор невозможен',
  'аренду нельзя подобрать под покупку даже прямой вставкой');
