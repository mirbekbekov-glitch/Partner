-- ИНВАРИАНТ 39. Тариф агентства.
--
--   а. На бесплатном тарифе в агентстве один агент. Второго не заводят ни
--      входом, ни переводом, ни правкой администратором.
--   б. Тариф не понижается до бесплатного, пока людей больше одного: иначе
--      правило обходится со стороны агентства, а не агента.
--   в. Выгрузка на ЧУЖУЮ площадку — за деньги. Наш каталог бесплатен.
--   г. Объекты и клиенты не ограничены ни на одном тарифе. Это и есть
--      главное решение: лимит на размер базы заставил бы агента решать,
--      какой объект заводить, а какой нет, и каталог перестал бы расти.
--   д. Новый человек получает СВОЁ агентство, а не попадает в чужое.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role postgres;
set request.jwt.claims = '{}';

-- ---------------------------------------------------------------------------
-- 39а. Один агент на бесплатном
-- ---------------------------------------------------------------------------
\set ag_solo '00000000-0000-0000-0000-0000000a5001'
insert into agencies (id, name, city, plan)
values (:'ag_solo', 'Одиночка Эркин', 'Бишкек', 'solo');

\set a_solo '00000000-0000-0000-0000-0000000005a1'
insert into agents (id, email, full_name, agency_id, role, status)
values (:'a_solo', 'erkin@solo.kg', 'Эркин', :'ag_solo', 'head', 'approved');

select test.eq(
  (select count(*)::int from agents where agency_id = :'ag_solo' and status <> 'blocked'),
  1,
  'в бесплатном агентстве один агент: проверки ниже не вакуумны');

select test.throws(
  'insert into agents (email, full_name, agency_id, status) values
     (''vtoroy@solo.kg'', ''Второй'', ''' || :'ag_solo' || ''', ''pending'')',
  'INVARIANT_39',
  'второго агента на бесплатный тариф не завести');

-- Перевод из другого агентства — тот же запрет. Путей завести второго
-- человека три, и держать правило на одном значит не держать его вовсе.
select test.throws(
  'update agents set agency_id = ''' || :'ag_solo' || ''' where id = ''' || :'agent_chyngyz' || '''',
  'INVARIANT_39',
  'и переводом из другого агентства тоже');

-- Заблокированный место не занимает: блокировка и есть способ его освободить.
set role postgres;
update agents set status = 'blocked' where id = :'a_solo';
insert into agents (id, email, full_name, agency_id, role, status)
values ('00000000-0000-0000-0000-0000000005a2', 'smena@solo.kg', 'Смена',
        :'ag_solo', 'head', 'approved');
select test.eq(
  (select count(*)::int from agents where agency_id = :'ag_solo' and status <> 'blocked'),
  1,
  'на место заблокированного заходит новый');

-- ---------------------------------------------------------------------------
-- 39б. Тариф не понижается под людьми
-- ---------------------------------------------------------------------------
select test.throws(
  'update agencies set plan = ''solo'' where id = ''00000000-0000-0000-0000-00000000aa01''',
  'INVARIANT_39',
  'агентство с командой на бесплатный тариф не перевести');

-- А наверх — свободно: за деньги ограничений нет.
select test.eq(
  (select plan from agencies where id = :'ag_solo'), 'solo',
  'агентство пока на бесплатном: проверка ниже не вакуумна');
update agencies set plan = 'team' where id = :'ag_solo';
select test.eq(
  (select plan from agencies where id = :'ag_solo'), 'team',
  'на платный тариф переводится свободно');
update agencies set plan = 'solo' where id = :'ag_solo';

-- ---------------------------------------------------------------------------
-- 39в. Площадка — за деньги, наш каталог — нет
-- ---------------------------------------------------------------------------
-- Объект заводится агенту бесплатного агентства: договор, публикация, каналы.
set role postgres;
set request.jwt.claims = '{}';

\set obj_solo '00000000-0000-0000-0000-0000000f5001'
insert into objects (id, kind, deal_type, address, zone, price, created_by_agent_id)
values (:'obj_solo', 'flat', 'sale', 'Одиночкина 1', 'Центр', 60000,
        '00000000-0000-0000-0000-0000000005a2');
insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_solo', :'contact_owner', 'owner', 1.0);
insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_solo', 'exclusive', current_date - 10, 60000,
        '00000000-0000-0000-0000-0000000005a2', true, 'active');

-- Наш каталог бесплатному доступен целиком.
insert into publication_channels (object_id, channel, enabled)
values (:'obj_solo', 'site', true);
select test.ok(
  (select enabled from publication_channels
    where object_id = :'obj_solo' and channel = 'site'),
  'наш каталог на бесплатном тарифе доступен');

-- Наша же поверхность — тоже. Сначала утверждается САМО РЕШЕНИЕ о данных:
-- какие каналы считаются чужими, задаётся строкой в channel_feeds, и ошибка
-- в этой строке превратила бы нашу витрину в платную. Без этой проверки
-- мутация «объявить mini_app чужим» валила тест сообщением базы, а не
-- проверкой, которая за это отвечает.
select test.ok(not app.channel_is_external('mini_app'),
  'наша витрина в телеграме чужой площадкой не считается');

insert into publication_channels (object_id, channel, enabled)
values (:'obj_solo', 'mini_app', true);
select test.ok(
  (select enabled from publication_channels
    where object_id = :'obj_solo' and channel = 'mini_app'),
  'и наша витрина в телеграме тоже: платим за неё мы');

-- А чужая — нет.
select test.throws(
  'insert into publication_channels (object_id, channel, enabled) values
     (''' || :'obj_solo' || ''', ''lalafo'', true)',
  'INVARIANT_39',
  'выгрузка на чужую площадку на бесплатном тарифе не включается');

-- Выключенной строкой — можно: это намерение, а не выгрузка. Агент видит
-- список площадок и понимает, чего лишён, вместо пустого экрана.
insert into publication_channels (object_id, channel, enabled)
values (:'obj_solo', 'lalafo', false);
select test.ok(
  not (select enabled from publication_channels
        where object_id = :'obj_solo' and channel = 'lalafo'),
  'выключенная строка площадки заводится: экран должен показывать, чего нет');

-- Тариф сменился — площадка открылась. Запрет про деньги, а не про объект.
set role postgres;
update agencies set plan = 'team' where id = :'ag_solo';
update publication_channels set enabled = true
 where object_id = :'obj_solo' and channel = 'lalafo';
select test.ok(
  (select enabled from publication_channels
    where object_id = :'obj_solo' and channel = 'lalafo'),
  'на платном тарифе та же площадка включается');
update agencies set plan = 'solo' where id = :'ag_solo';

-- ---------------------------------------------------------------------------
-- 39г. Объекты и клиенты не ограничены
-- ---------------------------------------------------------------------------
-- Это главное решение тарифа, и проверяется оно прямо: лимита нет. Проверка
-- выглядит простой, но защищает от соблазна «добавим лимитик» — спецификация
-- объясняет, почему он убил бы каталог.
set role postgres;
insert into objects (kind, deal_type, address, zone, price, created_by_agent_id)
select 'flat', 'sale', 'Безлимитная ' || i, 'Центр', 50000 + i,
       '00000000-0000-0000-0000-0000000005a2'
  from generate_series(1, 40) i;

select test.ok(
  (select count(*)::int from objects
    where created_by_agent_id = '00000000-0000-0000-0000-0000000005a2') > 40,
  'сорок с лишним объектов на бесплатном тарифе заводятся без отказа');

insert into contacts (kind, name, owner_agent_id, roles, source)
select 'person', 'Клиент ' || i, '00000000-0000-0000-0000-0000000005a2',
       '{buyer}', 'проверка'
  from generate_series(1, 40) i;

select test.ok(
  (select count(*)::int from contacts
    where owner_agent_id = '00000000-0000-0000-0000-0000000005a2') >= 40,
  'и сорок клиентов тоже');

-- ---------------------------------------------------------------------------
-- 39д. Новый человек получает СВОЁ агентство
-- ---------------------------------------------------------------------------
-- До этой миграции agency_id брался из умолчания колонки, а оно со времён
-- 0042 указывает на Liberterra: всякий, кто подтвердил почту, становился
-- членом НАШЕГО агентства и ждал одобрения внутри него. Одобрение впускало
-- чужого человека к видимости наших клиентов и сделок по инварианту 33.
--
-- Клеймы свои: вход по почте — путь инварианта 6, и человек в нём новый.
\set claims_solo '{"sub":"00000000-0000-0000-0000-00000000b901","role":"authenticated","email":"nurbek@solo.kg"}'
set role postgres;
set request.jwt.claims = :'claims_solo';
select * from app.login_by_email('Одиночка Нурбек'::text) \gset solo1_

select test.ok(
  :'solo1_agency_id'::text <> '00000000-0000-0000-0000-00000000aa01',
  'новый агент заведён НЕ в наше агентство');

select test.eq(
  (select plan from agencies where id = :'solo1_agency_id'), 'solo',
  'его агентство на бесплатном тарифе');

select test.eq(
  (select name from agencies where id = :'solo1_agency_id'), 'Одиночка Нурбек',
  'и названо его именем');

select test.eq(:'solo1_role'::text, 'head'::text,
  'в своём агентстве он руководитель: спрашивать разрешения не у кого');

select test.eq(:'solo1_status'::text, 'pending'::text,
  'но одобрения администратора это не отменяет: тариф про деньги, а не про то, кого пускать');

select test.eq(
  (select count(*)::int from agents where agency_id = :'solo1_agency_id'), 1,
  'и он в нём один');

-- Второй вход тем же адресом агентства не плодит.
set request.jwt.claims = :'claims_solo';
select * from app.login_by_email('Одиночка Нурбек'::text) \gset solo2_
select test.eq(:'solo2_agency_id'::text, :'solo1_agency_id'::text,
  'повторный вход не заводит второго агентства');
