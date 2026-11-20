-- Списки объектов и потребностей (миграция 0014).
--
-- Главное: строка списка обязана оставаться видимой агенту, которому
-- контакт по инварианту 4 не положен. Если бы контакты присоединялись
-- join-ом, объект просто исчез бы из списка.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m1_
select * from create_match(:'obj1', :'req2') \gset m2_
reset role;

-- ===========================================================================
-- Агент, которому контакты положены
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(
  (select owners from object_list_v where id = :'obj1'),
  'Орозов Собственник', 'Айбек видит собственника в списке объектов');
reset role;

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  (select client_name from requirement_list_v where id = :'req1'),
  'Жумаев Клиент', 'Бакыт видит клиента в списке потребностей');
reset role;

-- ===========================================================================
-- Посторонний агент: строки есть, контактов нет
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.eq(test.visible_count($$select 1 from object_list_v$$), 3::bigint,
  'Чынгыз видит ВСЕ три объекта в списке');
select test.ok((select owners is null from object_list_v where id = :'obj1'),
  'но собственник у него пуст');

select test.eq(test.visible_count($$select 1 from requirement_list_v$$), 2::bigint,
  'Чынгыз видит обе потребности в списке');
select test.ok((select client_name is null from requirement_list_v where id = :'req1'),
  'но клиент у него пуст');

-- Остальное он видеть обязан: «объект, условия и комиссия да».
select test.ok(
  (select address is not null and price is not null and active_mandate_id is not null
     and commission_total is not null
     from object_list_v where id = :'obj1'),
  'адрес, цена, мандат и комиссия ему видны');

-- ===========================================================================
-- Счётчики
-- ===========================================================================

select test.eq((select matches_count from object_list_v where id = :'obj1'), 2::bigint,
  'у объекта посчитаны оба подбора');
select test.eq((select matches_count from requirement_list_v where id = :'req1'), 1::bigint,
  'у потребности посчитан её подбор');
select test.eq((select matches_count from object_list_v where id = :'obj2'), 0::bigint,
  'объект без подборов показывает ноль, а не NULL');

-- Несколько собственников не размножают строку объекта.
reset role;
insert into contacts (id, name, owner_agent_id)
values ('00000000-0000-0000-0000-00000000c003', 'Второй Совладелец', :'agent_aibek');
-- Доля не указана: этот тест про то, что два собственника не размножают
-- строку объекта, а не про доли. С 0023 сумма долей по объекту не может
-- выйти за единицу, а у obj1 все сто процентов уже у собственника.
insert into object_ownerships (object_id, contact_id, role)
values (:'obj1', '00000000-0000-0000-0000-00000000c003', 'co_owner');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(test.visible_count(format($$select 1 from object_list_v where id = %L$$, :'obj1')),
  1::bigint, 'два собственника дают ОДНУ строку объекта, а не две');
select test.eq((select owners from object_list_v where id = :'obj1'),
  'Второй Совладелец, Орозов Собственник', 'оба собственника собраны в одно поле');
reset role;

-- ===========================================================================
-- Состояние мандата видно в списке
-- ===========================================================================
-- Объект без активного мандата публиковать нельзя, поэтому в списке это
-- должно быть заметно сразу.

insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fb001', 'flat', 'sale', 'Без мандата', 40000, :'agent_aibek');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(
  (select active_mandate_id is null from object_list_v
    where id = '00000000-0000-0000-0000-0000000fb001'),
  'объект без мандата виден в списке с пустым мандатом');
select test.eq(
  (select publication_state from object_list_v
    where id = '00000000-0000-0000-0000-0000000fb001'),
  'draft'::publication_state, 'и остаётся черновиком');
select test.ok(
  (select not contract_confirmed from object_list_v where id = :'obj3'),
  'неподтверждённый договор в списке заметен');
reset role;

-- ===========================================================================
-- Анониму списки недоступны
-- ===========================================================================
reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from object_list_v$$, 'permission denied',
  'список объектов анониму недоступен');
select test.throws($$select 1 from requirement_list_v$$, 'permission denied',
  'список потребностей анониму недоступен');
reset role;
