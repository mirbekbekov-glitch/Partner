-- Передача клиента и объекта коллеге (миграция 0019).
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m1_
select * from create_match(:'obj2', :'req1') \gset m2_
reset role;

-- ===========================================================================
-- Передача клиента двигает контакт, потребности И подборы
-- ===========================================================================
-- Главное здесь: подборы. Без них инвариант 0018 остался бы нарушенным на
-- существующих строках, и расхождение жило бы молча.

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select transfer_contact(:'contact_client', :'agent_chyngyz') as t \gset
select test.eq((:'t'::jsonb ->> 'requirements')::int, 2,
  'переехали обе открытые потребности клиента');
select test.eq((:'t'::jsonb ->> 'matches')::int, 2,
  'и оба подбора по ним');
reset role;

select test.eq((select owner_agent_id from contacts where id = :'contact_client')::text,
  :'agent_chyngyz'::text, 'контакт перешёл к новому агенту');
select test.eq((select agent_id from requirements where id = :'req1')::text,
  :'agent_chyngyz'::text, 'потребность перешла');
select test.eq((select closing_agent_id from matches where id = :'m1_id')::text,
  :'agent_chyngyz'::text, 'closing-агент подбора перешёл вместе с потребностью');

-- Инвариант 0018 цел: подбор правится, и триггер не возражает.
select test.eq((select closing_agent_id from matches where id = :'m2_id')::text,
  :'agent_chyngyz'::text, 'второй подбор тоже');
update matches set status = 'interested' where id = :'m1_id';
select test.ok(true, 'подбор после передачи остаётся правимым: расхождения нет');

-- И комиссия теперь считается на нового агента.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(
  (select closing_agent_id from match_commission_v where match_id = :'m1_id')::text,
  :'agent_chyngyz'::text, 'доля closing-агента считается на нового агента');
-- Новый владелец видит телефон клиента: он теперь owner_agent.
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$,
                            :'contact_client')),
  1::bigint, 'новый владелец видит телефон клиента');
reset role;

-- А прежний — больше нет.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$,
                            :'contact_client')),
  0::bigint, 'прежний агент телефон клиента больше не видит');
reset role;

-- ===========================================================================
-- Закрытая работа остаётся за тем, кто её делал
-- ===========================================================================

insert into requirements (id, contact_id, deal_type, budget_max, agent_id, status, closed_reason)
values ('00000000-0000-0000-0000-00000000e900', :'contact_owner', 'sale', 90000,
        :'agent_aibek', 'closed', 'купил сам');
insert into requirements (id, contact_id, deal_type, budget_max, agent_id, status)
values ('00000000-0000-0000-0000-00000000e901', :'contact_owner', 'sale', 90000,
        :'agent_aibek', 'qualified');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select transfer_contact(:'contact_owner', :'agent_bakyt') as t2 \gset
select test.eq((:'t2'::jsonb ->> 'requirements')::int, 1,
  'переехала только открытая потребность');
reset role;

select test.eq(
  (select agent_id from requirements where id = '00000000-0000-0000-0000-00000000e900')::text,
  :'agent_aibek'::text, 'закрытая потребность осталась за тем, кто её вёл');
select test.eq(
  (select agent_id from requirements where id = '00000000-0000-0000-0000-00000000e901')::text,
  :'agent_bakyt'::text, 'открытая переехала');

-- ===========================================================================
-- Открытая сделка передачу останавливает
-- ===========================================================================
-- Иначе сделка становится незакрываемой: её агенты заморожены, а подбор
-- уехал бы к другому. Проверено запросом до 0019 — close_deal() падал.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select * from create_deal_from_match(:'m1_id') \gset d_
select test.throws(
  format($$select transfer_contact(%L, %L)$$, :'contact_client', :'agent_bakyt'),
  'идут незавершённые сделки',
  'передача клиента с открытой сделкой отклонена');
-- И сообщение называет, что именно мешает.
select test.throws(
  format($$select transfer_contact(%L, %L)$$, :'contact_client', :'agent_bakyt'),
  'Чүй 120',
  'отказ называет адрес объекта, по которому идёт сделка');
reset role;

select test.eq((select owner_agent_id from contacts where id = :'contact_client')::text,
  :'agent_chyngyz'::text, 'клиент остался у прежнего агента');

-- Сделка при этом закрывается нормально: передача её не сломала.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq((close_deal(:'d_id', 84000)).status, 'closed'::deal_status,
  'сделка закрывается: передача ничего не испортила');
reset role;

-- ===========================================================================
-- Передача объекта двигает и долю listing-агента
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select transfer_object(:'obj3', :'agent_bakyt') as t3 \gset
select test.ok((:'t3'::jsonb ->> 'mandate_moved')::boolean,
  'мандат переехал вместе с объектом');
reset role;

select test.eq((select created_by_agent_id from objects where id = :'obj3')::text,
  :'agent_bakyt'::text, 'объект перешёл к новому агенту');
select test.eq((select listing_agent_id from mandates
                 where object_id = :'obj3' and status = 'active')::text,
  :'agent_bakyt'::text, 'listing-агент мандата перешёл: с ним и доля в комиссии');

-- Новый владелец может править и публиковать.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.ok((select can_edit_object(:'obj3')), 'новый владелец может править объект');
select test.eq(
  (update_object(p_id => :'obj3', p_kind => 'house', p_deal_type => 'sale',
                 p_address => 'Арча-Бешик, уч. 14', p_price => 155000)).price,
  155000::numeric, 'и правит его');
reset role;

-- А прежний — больше нет.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(not can_edit_object(:'obj3'), 'прежний владелец объект больше не правит');
select test.throws(
  format($$select update_object(p_id => %L, p_kind => 'house', p_deal_type => 'sale',
                                p_address => 'назад', p_price => 1)$$, :'obj3'),
  'FORBIDDEN',
  'и попытка правки отклонена');
reset role;

-- ===========================================================================
-- Кто может передавать и кому
-- ===========================================================================

-- Чужое не передашь.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
-- Получатель НЕ сам Айбек: иначе отказать может проверка «передаёте себе»,
-- и какой именно слой сработал, не отличить. Это нашлось мутацией.
select test.throws(
  format($$select transfer_contact(%L, %L)$$, :'contact_client', :'agent_bakyt'),
  'передать клиента может тот, кто его ведёт',
  'чужого клиента передать нельзя');

-- И отдельно: забрать чужого клиента себе передачей тоже нельзя.
select test.throws(
  format($$select transfer_contact(%L, %L)$$, :'contact_client', :'agent_aibek'),
  'FORBIDDEN',
  'и забрать чужого клиента себе нельзя');
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj3', :'agent_chyngyz'),
  'передать объект может тот, кто его завёл',
  'чужой объект передать нельзя');
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj3', :'agent_aibek'),
  'FORBIDDEN',
  'и забрать чужой объект себе нельзя');

-- Себе передавать нечего.
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj1', :'agent_aibek'),
  'это вы и есть',
  'передача самому себе отклонена');

-- Неодобренному агенту передать нельзя: он не работает.
select test.throws(
  format($$select transfer_object(%L, %L)$$, :'obj1',
         (select id from agents where telegram_id = 1004)),
  'не одобрен',
  'передача неодобренному агенту отклонена');
reset role;

-- Админ передаёт что угодно.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok((transfer_object(:'obj1', :'agent_chyngyz')) is not null,
  'админ передаёт любой объект');
reset role;

-- ===========================================================================
-- Журнал: передача видна (инвариант 7)
-- ===========================================================================
select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'contact' and action = 'update'
      and diff ? 'owner_agent_id'),
  'передача клиента записана в журнал с прежним и новым агентом');
select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'mandate' and action = 'update'
      and diff ? 'listing_agent_id'),
  'переезд listing-агента мандата записан в журнал');

-- ===========================================================================
-- Кому можно передать: список коллег
-- ===========================================================================
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.ok(
  (select count(*) > 0 from transfer_targets_v where id = :'agent_aibek'),
  'в списке получателей есть коллеги');
select test.eq(
  (select count(*)::int from transfer_targets_v where id = :'agent_bakyt'), 0,
  'себя в списке получателей нет');
select test.eq(
  (select count(*)::int from transfer_targets_v
    where id = (select id from agents where telegram_id = 1004)), 0,
  'неодобренных в списке получателей нет');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from transfer_targets_v$$, 'permission denied',
  'список получателей анониму недоступен');
reset role;
