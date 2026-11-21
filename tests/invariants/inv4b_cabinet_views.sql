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

-- С инварианта 34 работа личная: подбор по чужому объекту видит агент
-- потребности, агент объекта и руководитель — но не посторонний коллега.
-- Раньше его видел любой агент, и это утверждение закрепляло старое правило.
select test.eq(
  test.visible_count(format($$select 1 from object_matches_v where object_id = %L$$, :'obj1')),
  0::bigint, 'Чынгыз подбор на карточке чужого объекта НЕ видит');

-- Раньше строка подбора была видна всем, а имя клиента в ней пряталось.
-- Теперь прячется сама строка, и проверять нечего — но проверить стоит, что
-- имя не утекает другим путём: через представление без фильтра по объекту.
select test.eq(
  test.visible_count($$select 1 from object_matches_v where client_name is not null$$),
  0::bigint,
  'и ни одного чужого имени клиента ему не видно ни в одной строке');

-- И комиссия по чужому подбору тоже исчезла вместе со строкой. Прежде она
-- была видна всем агентам: «объект и условия да, контакт нет». С инварианта
-- 34 граница сдвинулась — чужая работа чужая целиком.
select test.eq(
  test.visible_count(format($$select 1 from object_matches_v where match_id = %L$$, :'m_id')),
  0::bigint,
  'и комиссии по чужому подбору — тоже');

-- То же со стороны потребности: чужого клиента постороннему не видно.
select test.eq(
  test.visible_count(format($$select 1 from requirement_matches_v where requirement_id = %L$$, :'req1')),
  0::bigint, 'и на карточке чужой потребности подборов он не видит');
reset role;

-- ---- А вот участник подбора видит строку, но не контакт ------------------
-- Это и есть инвариант 4 в чистом виде: Бакыт ведёт клиента и подбор, а
-- собственника чужого объекта не видит. Проверка переехала сюда с
-- постороннего агента, которому с инварианта 34 не видно и самой строки.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select test.ok(
  (select owner_name is null from requirement_matches_v where match_id = :'m_id'),
  'имя собственника агенту потребности не видно');
select test.ok(
  (select address is not null and price is not null and mandate_id is not null
     from requirement_matches_v where match_id = :'m_id'),
  'а адрес, цена и мандат — видны: без них подбор бесполезен');
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
set role anon;
select test.throws($$select 1 from object_matches_v$$, 'permission denied',
  'представления кабинета анониму недоступны');
select test.throws($$select 1 from requirement_matches_v$$, 'permission denied',
  'представление подборов потребности анониму недоступно');
reset role;
