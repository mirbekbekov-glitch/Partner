-- ИНВАРИАНТ 4. Телефон собственника и клиента виден только owner_agent
--              контакта, агентам внутри активной сделки по этому объекту
--              и админу. Остальным агентам: объект, условия, комиссия — да,
--              контакт — нет.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 4а. owner_agent видит свой контакт ----------------------------------
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  1::bigint, 'Айбек (привёл собственника) видит телефон собственника');
select test.eq(
  test.visible_count(format($$select 1 from contacts where id = %L$$, :'contact_owner')),
  1::bigint, 'Айбек видит сам контакт собственника');
-- Но чужого клиента — нет.
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_client')),
  0::bigint, 'Айбек НЕ видит телефон клиента, которого привёл Бакыт');
reset role;

-- ---- 4б. Посторонний агент: объект да, контакт нет -----------------------
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'Чынгыз НЕ видит телефон собственника');
select test.eq(
  test.visible_count(format($$select 1 from contacts where id = %L$$, :'contact_owner')),
  0::bigint, 'Чынгыз НЕ видит контакт собственника');
-- Связь объект↔контакт тоже закрыта: иначе инвариант обходился бы одним join.
select test.eq(
  test.visible_count(format($$select 1 from object_ownerships where object_id = %L$$, :'obj1')),
  0::bigint, 'Чынгыз НЕ видит связь объекта с собственником');

-- А вот это он видеть обязан.
select test.eq(
  test.visible_count(format($$select 1 from objects where id = %L$$, :'obj1')),
  1::bigint, 'Чынгыз видит объект');
select test.eq(
  test.visible_count(format($$select 1 from mandates where object_id = %L$$, :'obj1')),
  1::bigint, 'Чынгыз видит условия мандата');

-- ---- 4в. Подбор и назначенный показ доступа НЕ дают ----------------------
-- Это тонкое место: агент ведёт показ, но сделки нет — телефона он не получает.
--
-- Потребность Чынгыз заводит себе сам: по инварианту 20 подбор ведёт агент
-- потребности, и раньше этот тест пользовался чужой — ровно той дырой,
-- которую инвариант 20 закрыл.
select id as own_req from create_requirement(
  'sale', p_client_name => 'Клиент Чынгыза', p_client_phone => '0700 31 31 31',
  p_budget_min => 50000, p_budget_max => 250000) \gset

select * from create_match(:'obj3', :'own_req') \gset cm_
update matches set status = 'showing_scheduled', showing_at = now() + interval '1 day'
 where id = :'cm_id';
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'подбор с назначенным показом НЕ открывает телефон собственника');
reset role;

-- ---- 4г. Активная сделка открывает телефон её участникам -----------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'до сделки Бакыт телефон собственника не видит');

select * from create_match(:'obj1', :'req1') \gset dm_
select * from create_deal_from_match(:'dm_id') \gset dd_

select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  1::bigint, 'внутри активной сделки Бакыт видит телефон собственника');
select test.eq(
  test.visible_count(format($$select 1 from contacts where id = %L$$, :'contact_owner')),
  1::bigint, 'внутри активной сделки Бакыт видит контакт собственника');
reset role;

-- Посторонний агент доступа так и не получил.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'чужая активная сделка Чынгызу телефон не открывает');
-- И комиссию по ней тоже не видит. Так было не всегда: до инварианта 34
-- суммы по сделке видел любой агент агентства — «объект, условия и
-- комиссия да». Теперь работа личная, и чужая комиссия к ней относится.
select test.eq(
  test.visible_count(format($$select 1 from deal_commission_v where deal_id = %L$$, :'dd_id')),
  0::bigint, 'и комиссию по чужой сделке Чынгыз не видит');

-- А руководитель агентства видит: у него это отчёт, а не любопытство.
set request.jwt.claims = :'claims_admin';
select test.eq(
  test.visible_count(format($$select 1 from deal_commission_v where deal_id = %L$$, :'dd_id')),
  1::bigint, 'руководителю комиссия по сделке агентства видна');
set request.jwt.claims = :'claims_chyngyz';
reset role;

-- ---- 4д. Закрытие сделки доступ закрывает --------------------------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from close_deal(:'dd_id', 85000) \gset fin_
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'после закрытия сделки доступ к телефону закрывается');
reset role;

-- ---- 4е. Админ видит всё -------------------------------------------------
set request.jwt.claims = :'claims_admin';
-- Сколько телефонов в базе, тест не знает и знать не должен: «все» — это
-- правило, а «2» — снимок содержимого, который ломается от любого нового
-- клиента в соседней проверке.
set role postgres;
select count(*)::bigint as all_phones from contact_phones \gset

set role authenticated;
set request.jwt.claims = :'claims_admin';
select test.eq(
  test.visible_count($$select 1 from contact_phones$$), :'all_phones'::bigint,
  'админ видит все телефоны');
reset role;

-- ---- 4ж. Аноним и неодобренный агент -------------------------------------
set role anon;
-- Анониму таблица телефонов вообще не выдана грантом, поэтому запрос не
-- возвращает ноль строк, а отклоняется. Это строже, чем пустой результат.
select test.throws(
  $$select 1 from contact_phones$$,
  'permission denied',
  'анониму таблица телефонов недоступна на уровне прав');
-- Объектов было три, но obj1 ушёл из каталога выше в этом же тесте: его
-- сделка закрыта, значит мандат закрыт, значит публикация снята.
select test.eq(test.visible_count($$select 1 from public_catalog_v$$), 2::bigint,
  'аноним видит каталог без проданного объекта');
select test.eq(
  test.visible_count(format($$select 1 from public_catalog_v where id = %L$$, :'obj1')),
  0::bigint, 'проданный объект из публичного каталога исчез');
select test.eq(
  test.visible_count(format($$select 1 from public_catalog_v where id = %L$$, :'obj2')),
  1::bigint, 'непроданный объект в каталоге остался');
reset role;

set request.jwt.claims = :'claims_pending';
set role authenticated;
select test.eq(test.visible_count($$select 1 from contact_phones$$), 0::bigint,
  'неодобренный агент не видит телефонов');
select test.eq(test.visible_count($$select 1 from requirements$$), 0::bigint,
  'неодобренный агент не видит CRM');
reset role;
