-- ИНВАРИАНТ 6, третья редакция. Один человек — один аккаунт по АДРЕСУ ПОЧТЫ.
--   Адрес приводится к единому виду в базе, а не в клиенте;
--   адрес берётся из проверенных клеймов входа, а не из аргумента;
--   повторный вход не создаёт дубликат и не теряет владение объектами;
--   телефон остался, перестал быть ключом и записан НЕПОДТВЕРЖДЁННЫМ.
--
-- Вторая редакция держала ключ на телефоне (0011). Подтверждать телефон
-- нечем, пока не подключён WhatsApp Business API, поэтому ключом стала почта
-- (0034). Чем это слабее — написано в самой миграции; здесь проверяется, что
-- заявленное работает.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Клеймы с ПОДТВЕРЖДЁННЫМ адресом: так их ставит служба входа после кода.
-- Адрес идёт с заглавными буквами и пробелами — именно в этом виде, поэтому
-- его и нормализуем.
\set claims_new      '{"sub":"00000000-0000-0000-0000-00000000b501","role":"authenticated","email":"Novyi.Agent@Partner.KG"}'
\set claims_new_case '{"sub":"00000000-0000-0000-0000-00000000b501","role":"authenticated","email":" novyi.agent@partner.kg "}'
\set claims_nomail   '{"sub":"00000000-0000-0000-0000-00000000b502","role":"authenticated"}'

select count(*) as n0 from agents \gset

-- ---- 6а. Нормализация это часть инварианта -------------------------------
-- Иначе один человек получил бы по аккаунту на каждый способ записи адреса.
select test.eq(app.normalize_email('Ivan@Mail.KG'),   'ivan@mail.kg', 'регистр приведён к нижнему');
select test.eq(app.normalize_email('  ivan@mail.kg '), 'ivan@mail.kg', 'пробелы по краям убраны');
select test.ok(app.normalize_email('ivan@mail')  is null, 'адрес без зоны не адрес');
select test.ok(app.normalize_email('ivan mail.kg') is null, 'строка без собаки не адрес');
select test.ok(app.normalize_email('a@b@c.kg')   is null, 'две собаки не адрес');
select test.ok(app.normalize_email('не почта')   is null, 'текст не адрес');

-- Плюс-адресацию и точки НЕ трогаем, и это решение, а не упущение: у Gmail
-- они значат одно, у остальных другое, и «умная» нормализация однажды сольёт
-- два разных ящика в один аккаунт.
select test.eq(app.normalize_email('ivan+kvartiry@mail.kg'), 'ivan+kvartiry@mail.kg',
  'плюс-адрес остаётся отдельным адресом — осознанная слабость ключа');

-- Нормализация работает и на уже засеянных данных.
select test.eq(
  (select email from agents where id = :'agent_admin'), 'admin@partner.kg',
  'адрес из сценария приёмки сохранён нормализованным');

-- ---- 6б. Первый вход создаёт аккаунт по адресу из клеймов ------------------
set request.jwt.claims = :'claims_new';
select * from app.login_by_email('Новый Агент'::text) \gset a1_
select test.ok(:'a1_id' is not null, 'первый вход создал аккаунт');
select test.eq(:'a1_email'::text, 'novyi.agent@partner.kg', 'адрес взят из клеймов и нормализован');
select test.ok(:'a1_email_verified_at' is not null, 'адрес отмечен подтверждённым');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'агентов стало ровно на одного больше');

-- Новый агент создаётся в статусе pending: CRM ему пока закрыта. Это и есть
-- единственная защита от второго аккаунта у одного человека, раз ящик
-- заводится за минуту.
select test.eq(:'a1_status'::text, 'pending', 'новый аккаунт не одобрен по умолчанию');

-- Телефона у нового агента нет, и это теперь законно. Читаем из таблицы, а
-- не из \gset: психологически NULL там не пустая строка, а ОТСУТСТВИЕ
-- переменной, и :'a1_phone' был бы синтаксической ошибкой.
select test.ok(
  (select phone from agents where id = :'a1_id') is null,
  'аккаунт без телефона возможен: ключ не он');

-- Объект во владении нового агента.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f6001', 'flat', 'sale', 'Владение 1', 70000, :'a1_id');

-- ---- 6в. Тот же адрес в другой записи — тот же аккаунт --------------------
set request.jwt.claims = :'claims_new_case';
select * from app.login_by_email('Новый Агент Переименован'::text) \gset a2_

select test.eq(:'a2_id'::text, :'a1_id'::text,
  'вход с адресом в другом регистре вернул ТОТ ЖЕ agents.id');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'дубликат аккаунта не создан');
select test.eq((select full_name from agents where id = :'a1_id'),
  'Новый Агент Переименован', 'имя обновилось на существующей строке');

-- ---- 6г. Владение объектами не потеряно ----------------------------------
select test.eq(
  (select created_by_agent_id from objects where id = '00000000-0000-0000-0000-0000000f6001')::text,
  :'a1_id'::text, 'объект остался за тем же агентом');

-- Вход без имени: привязка и имя не обнуляются.
set request.jwt.claims = :'claims_new';
select * from app.login_by_email() \gset a3_
select test.eq(:'a3_auth_user_id'::text, '00000000-0000-0000-0000-00000000b501',
  'вход без имени не стирает привязку к auth-пользователю');
select test.eq(:'a3_full_name'::text, 'Новый Агент Переименован',
  'вход без имени не стирает имя');

-- ---- 6д. Телефон при регистрации: со слов человека -----------------------
-- Его можно указать при создании аккаунта, и он сразу НЕПОДТВЕРЖДЁННЫЙ:
-- подтвердить его нечем, пока нет WhatsApp.
\set claims_phone '{"sub":"00000000-0000-0000-0000-00000000b503","role":"authenticated","email":"stelefonom@partner.kg"}'
set request.jwt.claims = :'claims_phone';
select * from app.login_by_email('С Телефоном'::text, '0777 12 34 56'::text) \gset p1_
select test.eq(:'p1_phone'::text, '+996777123456', 'телефон при регистрации нормализован');
select test.ok(
  (select phone_verified_at from agents where id = :'p1_id') is null,
  'телефон со слов человека не подтверждён — и это видно в данных, а не только на словах');

-- Повторный вход телефон не меняет: для этого есть профиль, а не вход.
select * from app.login_by_email('С Телефоном'::text, '0700 99 88 77'::text) \gset p2_
select test.eq(:'p2_phone'::text, '+996777123456', 'вход не переписывает телефон');

-- Занять чужой номер нельзя даже неподтверждённым: уникальность осталась.
\set claims_squat '{"sub":"00000000-0000-0000-0000-00000000b504","role":"authenticated","email":"squat@partner.kg"}'
set request.jwt.claims = :'claims_squat';
select test.throws(
  $$select app.login_by_email('Занимающий чужое'::text, '+996777123456'::text)$$,
  'agents_phone_key',
  'два агента с одним номером невозможны, даже когда номер не ключ');

-- ---- 6е. Второй аккаунт на тот же адрес невозможен ------------------------
select test.throws(
  $$insert into agents (email, full_name) values ('novyi.agent@partner.kg', 'Двойник')$$,
  'agents_email_key',
  'второй аккаунт на тот же адрес отклонён');

-- И через другую запись того же адреса — тоже: нормализация сводит их к одной.
select test.throws(
  $$insert into agents (email, full_name) values ('  NOVYI.Agent@Partner.KG ', 'Двойник в другом регистре')$$,
  'agents_email_key',
  'тот же адрес в другом регистре тоже отклонён');

-- ---- 6ж. Аккаунт без адреса невозможен -----------------------------------
-- Здесь ожидается конкретное сообщение: отсутствие адреса и мусор вместо
-- адреса это два разных отказа, и тест обязан их различать.
select test.throws(
  $$insert into agents (full_name) values ('Без почты')$$,
  'аккаунт без адреса почты невозможен',
  'аккаунт без адреса невозможен');

select test.throws(
  $$insert into agents (email, full_name) values ('не почта', 'С мусором вместо адреса')$$,
  'не похоже на адрес почты',
  'мусор вместо адреса отклонён');

-- ---- 6з. Адрес не принимается в аргументе --------------------------------
-- Вошедший без подтверждённого адреса не может занять чужой аккаунт.
set request.jwt.claims = :'claims_nomail';
select test.throws(
  $$select app.login_by_email('Самозванец')$$,
  'во входе нет подтверждённого адреса',
  'вход без подтверждённого адреса отклонён');

-- ---- 6и. Старых путей входа не осталось ----------------------------------
-- Урок 0011, повторённый дважды: оставить функцию значит оставить второй
-- способ создать аккаунт, то есть вторую дырку в этом же инварианте.
select test.eq(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname in ('login_by_telegram', 'login_by_phone')),
  0, 'входа по телеграму и по телефону больше нет');

-- ---- 6к. На неподтверждённый телефон ничего не опирается ------------------
-- Самая важная проверка этой редакции. Телефон теперь записан со слов
-- человека; если бы хоть одно правило системы верило ему, запись со слов
-- открывала бы чужое.
set role postgres;
set request.jwt.claims = '{}';
select test.eq(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.prosrc like '%agents%'
      and p.prosrc ~ 'a\.phone\s*=|agents\.phone\s*='
      and p.proname <> 'verify_login_code'),
  0,
  'ни одна функция схемы app не опознаёт агента по телефону');

-- Единственное исключение названо явно: проверка кода, пришедшего НА телефон.
-- И она требует подтверждённого номера — это видно в её тексте.
select test.ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'verify_login_code')
    like '%phone_verified_at is not null%',
  'вход по телефону возможен только для подтверждённого номера');
