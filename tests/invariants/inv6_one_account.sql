-- ИНВАРИАНТ 6, вторая редакция. Один человек — один аккаунт по номеру телефона.
--   Номер приводится к E.164 в базе, а не в клиенте;
--   номер берётся из проверенных клеймов входа, а не из аргумента;
--   повторный вход не создаёт дубликат и не теряет владение объектами.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Клеймы со ПОДТВЕРЖДЁННЫМ номером: так их отдаёт Supabase после кода.
-- Номер идёт без плюса — именно в этом виде, поэтому его и нормализуем.
\set claims_new      '{"sub":"00000000-0000-0000-0000-00000000b501","role":"authenticated","phone":"996555777888"}'
\set claims_new_loc  '{"sub":"00000000-0000-0000-0000-00000000b501","role":"authenticated","phone":"0555777888"}'
\set claims_nophone  '{"sub":"00000000-0000-0000-0000-00000000b502","role":"authenticated"}'

select count(*) as n0 from agents \gset

-- ---- 6а. Нормализация это часть инварианта -------------------------------
-- Иначе один человек получил бы по аккаунту на каждый способ записи номера.
select test.eq(app.normalize_phone('0700111222'),    '+996700111222', 'местный формат с нуля');
select test.eq(app.normalize_phone('+996 700 111-222'), '+996700111222', 'пробелы и дефисы убраны');
select test.eq(app.normalize_phone('996700111222'),  '+996700111222', 'код страны без плюса');
select test.eq(app.normalize_phone('700111222'),     '+996700111222', 'девять цифр без кода');
select test.eq(app.normalize_phone('+4915112345678'),'+4915112345678', 'иностранный в международном виде');
select test.ok(app.normalize_phone('123456') is null, 'слишком короткое не номер');
select test.ok(app.normalize_phone('не телефон') is null, 'текст не номер');

-- Нормализация работает и на уже засеянных данных.
select test.eq(
  (select phone from agents where id = :'agent_chyngyz'), '+996700100003',
  'номер из сценария приёмки сохранён нормализованным');

-- ---- 6б. Первый вход создаёт аккаунт по номеру из клеймов ------------------
set request.jwt.claims = :'claims_new';
select * from app.login_by_phone('Новый Агент'::text) \gset a1_
select test.ok(:'a1_id' is not null, 'первый вход создал аккаунт');
select test.eq(:'a1_phone'::text, '+996555777888', 'номер взят из клеймов и нормализован');
select test.ok(:'a1_phone_verified_at' is not null, 'номер отмечен подтверждённым');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'агентов стало ровно на одного больше');

-- Новый агент создаётся в статусе pending: CRM ему пока закрыта.
select test.eq(:'a1_status'::text, 'pending', 'новый аккаунт не одобрен по умолчанию');

-- Объект во владении нового агента.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f6001', 'flat', 'sale', 'Владение 1', 70000, :'a1_id');

-- ---- 6в. Тот же номер в другой записи — тот же аккаунт --------------------
-- Это главное, что даёт нормализация: «0555777888» и «996555777888» — один
-- человек, а не два.
set request.jwt.claims = :'claims_new_loc';
select * from app.login_by_phone('Новый Агент Переименован'::text) \gset a2_

select test.eq(:'a2_id'::text, :'a1_id'::text,
  'вход с номером в местном формате вернул ТОТ ЖЕ agents.id');
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
select * from app.login_by_phone() \gset a3_
select test.eq(:'a3_auth_user_id'::text, '00000000-0000-0000-0000-00000000b501',
  'вход без имени не стирает привязку к auth-пользователю');
select test.eq(:'a3_full_name'::text, 'Новый Агент Переименован',
  'вход без имени не стирает имя');

-- ---- 6д. Второй аккаунт на тот же номер невозможен ------------------------
select test.throws(
  $$insert into agents (phone, full_name) values ('+996555777888', 'Двойник')$$,
  'agents_phone_key',
  'второй аккаунт на тот же номер отклонён');

-- И через другую запись того же номера — тоже: нормализация сводит их к одной.
select test.throws(
  $$insert into agents (phone, full_name) values ('0555 777 888', 'Двойник в местном формате')$$,
  'agents_phone_key',
  'тот же номер в другом формате тоже отклонён');

-- ---- 6е. Аккаунт без номера невозможен -----------------------------------
-- Здесь тоже ожидается конкретное сообщение: отсутствие номера и мусор
-- вместо номера это два разных отказа, и тест обязан их различать.
select test.throws(
  $$insert into agents (full_name) values ('Без номера')$$,
  'аккаунт без номера телефона невозможен',
  'аккаунт без номера невозможен');

select test.throws(
  $$insert into agents (phone, full_name) values ('не телефон', 'С мусором вместо номера')$$,
  'не похоже на номер телефона',
  'мусор вместо номера отклонён');

-- ---- 6ж. Номер не принимается в аргументе --------------------------------
-- Вошедший без подтверждённого номера не может занять чужой аккаунт.
set request.jwt.claims = :'claims_nophone';
-- Ожидается именно это сообщение, а не любое с INVARIANT_6: иначе тест
-- прошёл бы и в случае, когда вход пускает дальше, а падает уже триггер.
select test.throws(
  $$select app.login_by_phone('Самозванец')$$,
  'во входе нет подтверждённого номера',
  'вход без подтверждённого номера отклонён');

-- ---- 6з. Telegram больше не ключ и не путь входа -------------------------
select test.ok(
  (select is_nullable = 'YES' from information_schema.columns
    where table_name = 'agents' and column_name = 'telegram_id'),
  'telegram_id стал необязательным полем');

select test.eq(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'login_by_telegram'),
  0, 'второго пути входа через Telegram не осталось');
