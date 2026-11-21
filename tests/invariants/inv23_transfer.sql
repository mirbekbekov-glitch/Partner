-- ИНВАРИАНТ 23. Передача клиента или объекта — одно действие. Незакрытая
--               работа переходит вместе с ними, закрытые сделки не меняют
--               сторон никогда.
--
-- Правило «ведёт тот, кто ведёт» закрыли инварианты 20 и 22, а способа
-- передать не было вовсе. В первый же отпуск это означает одно из двух:
-- либо работа встаёт, либо кто-то лезет в базу руками.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- ---- 23а. Объект передаёт тот, кто его ведёт ------------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj1', :'agent_chyngyz'),
  'INVARIANT_23: объект передаёт тот, кто его ведёт, или администратор',
  'чужой объект себе не забрать');

-- ---- 23б. Передача меняет владельца договора ------------------------------
set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select listing_agent_id from transfer_object(:'obj1', :'agent_bakyt')),
  :'agent_bakyt'::uuid, 'объект передан: владелец договора сменился');

-- И права перешли вместе с ним: это и есть смысл передачи.
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select price from update_object(:'obj1', 88000, 'Чүй 120, кв. 5')),
  88000::numeric, 'новый агент правит переданный объект');

set request.jwt.claims = :'claims_aibek';
select test.throws(
  format($$select update_object(%L, 1, 'Чүй 120, кв. 5')$$, :'obj1'),
  'INVARIANT_22: объект ведёт агент действующего договора',
  'прежний агент переданный объект больше не правит');

-- ---- 23в. Незакрытая сделка переходит вместе с объектом -------------------
-- Комиссия по ней ещё не зафиксирована, и получит её тот, кто доведёт дело
-- до конца.
set request.jwt.claims = :'claims_bakyt';
select id as m2 from create_match(:'obj3', :'req2') \gset
select id as d2 from create_deal_from_match(:'m2') \gset
select test.eq(
  (select listing_agent_id from deals where id = :'d2'),
  :'agent_aibek'::uuid, 'сделка завелась с прежним листинг-агентом');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select listing_agent_id from transfer_object(:'obj3', :'agent_chyngyz')),
  :'agent_chyngyz'::uuid, 'объект со сделкой передан');
-- Читает НОВЫЙ агент: передав объект, прежний перестал быть стороной сделки
-- и больше её не видит (инвариант 34). Это и есть смысл передачи.
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select listing_agent_id from deals where id = :'d2'),
  :'agent_chyngyz'::uuid, 'незакрытая сделка перешла вместе с объектом');
set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format($$select 1 from deals where id = %L$$, :'d2')),
  0::bigint, 'а прежний агент её больше не видит');

-- ---- 23г. Закрытая сделка сторон не меняет --------------------------------
-- Там комиссия уже посчитана и записана: менять стороны значит менять, кому
-- заплачено.
set request.jwt.claims = :'claims_chyngyz';
select commission_total as fixed from close_deal(:'d2', 120000) \gset
select test.eq(
  (select listing_agent_id from deals where id = :'d2'),
  :'agent_chyngyz'::uuid, 'закрыл тот, кому объект передали');

set role postgres;
set request.jwt.claims = '{}';
insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj3', 'non_exclusive', 120000, :'agent_chyngyz', true, 'active');

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select listing_agent_id from transfer_object(:'obj3', :'agent_aibek')),
  :'agent_aibek'::uuid, 'объект передан ещё раз, уже по новому договору');

select test.eq(
  (select listing_agent_id from deals where id = :'d2'),
  :'agent_chyngyz'::uuid,
  'закрытая сделка осталась за тем, кто её закрыл');

-- Подбор, за которым стоит закрытая сделка, при передаче клиента тоже не
-- двигается: сделка по нему уже записала, кто её вёл, и расходиться с этой
-- записью нельзя.
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select agent_id from transfer_requirement(:'req2', :'agent_aibek')),
  :'agent_aibek'::uuid, 'клиент с закрытой сделкой передан');
select test.eq(
  (select closing_agent_id from matches where id = :'m2'),
  :'agent_bakyt'::uuid,
  'подбор с закрытой сделкой остался за прежним агентом');
select test.eq(
  (select closing_agent_id from deals where id = :'d2'),
  :'agent_bakyt'::uuid, 'и сама закрытая сделка тоже');

-- И напрямую стороны закрытой сделки не поменять: здесь инвариант 3
-- пропустит (подбор-то можно подвинуть), а инвариант 23 — нет.
set role postgres;
set request.jwt.claims = '{}';
update matches set closing_agent_id = :'agent_aibek' where id = :'m2';
select test.throws(
  format($$update deals set closing_agent_id = %L where id = %L$$,
         :'agent_aibek', :'d2'),
  'INVARIANT_23: стороны закрытой сделки не меняются',
  'закрытую сделку не привести к новому агенту клиента');

-- ---- 23г-бис. Сорванная сделка при передаче не двигается ------------------
-- Закрытая сделка закрывает и мандат, поэтому на действующем договоре её не
-- бывает. А вот сорванная договор не закрывает — и передача объекта проходит
-- рядом с ней. Мутация, снимавшая отбор по состоянию сделки, выживала
-- именно потому, что этого случая в тесте не было.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
-- Потребность нужна своя: прежняя закрыта сделкой выше, а по закрытой
-- подбор невозможен (инвариант 2).
select id as req4 from create_requirement(
  'sale', p_client_name => 'Клиент для срыва', p_client_phone => '0700 71 71 71',
  p_budget_max => 500000) \gset
select id as m4 from create_match(:'obj2', :'req4') \gset
select id as d4 from create_deal_from_match(:'m4') \gset
select test.eq((select status from fail_deal(:'d4', 'клиент отказался')),
  'failed'::deal_status, 'сделка сорвана, договор остался действующим');

select test.eq(
  (select listing_agent_id from deals where id = :'d4'),
  :'agent_aibek'::uuid, 'сорванная сделка на прежнем листинг-агенте');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select listing_agent_id from transfer_object(:'obj2', :'agent_chyngyz')),
  :'agent_chyngyz'::uuid, 'объект с сорванной сделкой передан');
select test.eq(
  (select listing_agent_id from deals where id = :'d4'),
  :'agent_aibek'::uuid,
  'сорванная сделка осталась за прежним агентом: она тоже история');

-- И она остаётся РАБОЧЕЙ записью, а не окаменелостью. Это та самая ловушка,
-- ради которой уточнялся инвариант 3: он сверял стороны сделки с ТЕКУЩИМ
-- владельцем мандата, и после передачи любое обращение к прошлым сделкам
-- падало. Передача делала историю неизменяемой задним числом.
set role postgres;
set request.jwt.claims = '{}';
update deals set failure_reason = 'клиент отказался, уточнение'
 where id = :'d4';
select test.eq(
  (select failure_reason from deals where id = :'d4'),
  'клиент отказался, уточнение',
  'прошлую сделку можно править и после передачи объекта');

-- ---- 23д. Клиент передаётся вместе с подборами ----------------------------
set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select transfer_requirement(%L, %L)$$, :'req1', :'agent_chyngyz'),
  'INVARIANT_23: клиента передаёт тот, кто его ведёт, или администратор',
  'чужого клиента себе не забрать');

set request.jwt.claims = :'claims_bakyt';
select id as m3 from create_match(:'obj2', :'req1') \gset
select test.eq(
  (select closing_agent_id from matches where id = :'m3'),
  :'agent_bakyt'::uuid, 'подбор на прежнем агенте');

select test.eq(
  (select agent_id from transfer_requirement(:'req1', :'agent_chyngyz')),
  :'agent_chyngyz'::uuid, 'клиент передан');
-- Читает НОВЫЙ агент: передав клиента, прежний перестал видеть его подборы
-- (инвариант 34). В этом и смысл передачи.
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select closing_agent_id from matches where id = :'m3'),
  :'agent_chyngyz'::uuid,
  'подбор перешёл вместе с клиентом: иначе инвариант 20 не даст по нему работать');
set request.jwt.claims = :'claims_bakyt';

-- Новый агент работает по переданному клиенту, прежний — нет.
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select budget_max from update_requirement(:'req1', p_budget_max => 130000)),
  130000::numeric, 'новый агент правит условия переданного клиента');

set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select update_requirement(%L, p_budget_max => 1)$$, :'req1'),
  'INVARIANT_22: потребность правит её агент',
  'прежний агент переданного клиента больше не правит');

-- ---- 23е. Кому передавать нельзя ------------------------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select transfer_requirement(%L, %L)$$, :'req1', :'agent_chyngyz'),
  'INVARIANT_23: передавать самому себе незачем',
  'самому себе не передать');

select test.throws(
  format($$select transfer_requirement(%L, '00000000-0000-0000-0000-0000000000a4')$$,
         :'req1'),
  'INVARIANT_23: передавать можно только действующему агенту',
  'неодобренному агенту работу не отдать');

select test.throws(
  format($$select transfer_requirement(%L, '00000000-0000-0000-0000-00000000dead')$$,
         :'req1'),
  'INVARIANT_23: агент 00000000-0000-0000-0000-00000000dead не существует',
  'несуществующему агенту тоже');

-- ---- 23ж. Объект без договора передавать нечего ---------------------------
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000fa44', 'flat', 'sale',
        'Без договора', 50000, :'agent_aibek');

set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.throws(
  $$select transfer_object('00000000-0000-0000-0000-00000000fa44',
      '00000000-0000-0000-0000-0000000000a2')$$,
  'INVARIANT_23: у объекта нет действующего договора, передавать нечего',
  'объект без договора не передать');

-- ---- 23з. Администратор передаёт за ушедшего агента -----------------------
-- Главный случай: агент уволился и передать сам уже не может.
set request.jwt.claims = :'claims_admin';
select test.eq(
  (select agent_id from transfer_requirement(:'req1', :'agent_bakyt')),
  :'agent_bakyt'::uuid, 'администратор передаёт чужого клиента');

-- ---- 23и. Передача видна в журнале ----------------------------------------
-- Это действие про деньги: кто и когда отдал клиента, должно быть видно.
set role postgres;
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'requirement' and entity_id = :'req1'
      and action = 'update' and diff ? 'agent_id') >= 1,
  'передача клиента записана в журнал');
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'mandate' and diff ? 'listing_agent_id') >= 1,
  'передача объекта записана в журнал');

-- ---- 23к. Каталогу передача недоступна ------------------------------------
set role anon;
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj1', :'agent_bakyt'),
  'permission denied for function transfer_object',
  'аноним ничего не передаёт');
