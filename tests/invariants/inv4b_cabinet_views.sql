-- Представления кабинета (пункт 4) под инвариантом 4.
-- Подбор обязан быть виден агенту, которому контакт не положен: иначе
-- «объект, условия и комиссия да» не выполняется.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
select * from create_match(:'obj2', :'req1') \gset m2_
reset role;

-- ---- Агент, которому контакт положен -------------------------------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  (select client_name from object_matches_v where match_id = :'m_id'),
  'Жумаев Клиент', 'Бакыт (привёл клиента) видит имя клиента в списке подборов');
reset role;

-- ---- Посторонний агент: строка есть, контакта нет ------------------------
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.eq(
  test.visible_count(format($$select 1 from object_matches_v where object_id = %L$$, :'obj1')),
  1::bigint, 'Чынгыз ВИДИТ подбор на карточке объекта');

select test.ok(
  (select client_name is null from object_matches_v where match_id = :'m_id'),
  'но имя клиента у него пустое');

select test.ok(
  (select commission_total is not null from object_matches_v where match_id = :'m_id'),
  'а комиссия по подбору ему видна');

select test.ok(
  (select deal_type is not null and budget_max is not null
     from object_matches_v where match_id = :'m_id'),
  'и условия потребности ему видны');

-- То же со стороны потребности.
select test.eq(
  test.visible_count(format($$select 1 from requirement_matches_v where requirement_id = %L$$, :'req1')),
  2::bigint, 'Чынгыз видит оба подбора на карточке потребности');

select test.ok(
  (select owner_name is null from requirement_matches_v where match_id = :'m_id'),
  'имя собственника у него пустое');

select test.ok(
  (select address is not null and price is not null and mandate_id is not null
     from requirement_matches_v where match_id = :'m_id'),
  'адрес, цена и мандат ему видны');
reset role;

-- ---- Агент внутри активной сделки получает контакт -----------------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_deal_from_match(:'m_id') \gset d_
select test.eq(
  (select owner_name from requirement_matches_v where match_id = :'m_id'),
  'Орозов Собственник', 'внутри активной сделки собственник в списке появился');
select test.eq(
  (select deal_status from requirement_matches_v where match_id = :'m_id'),
  'deposit'::deal_status, 'сделка отражена в списке подборов');
reset role;

-- ---- Аноним к представлениям кабинета не допущен -------------------------
reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from object_matches_v$$, 'permission denied',
  'представления кабинета анониму недоступны');
select test.throws($$select 1 from requirement_matches_v$$, 'permission denied',
  'представление подборов потребности анониму недоступно');
reset role;
