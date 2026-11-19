-- ИНВАРИАНТ 6. Один человек — один аккаунт, привязанный к существующей
--              Telegram-идентичности. Повторный вход не создаёт дубликат
--              и не теряет владение объектами.
\i tests/actors.sql
\set ON_ERROR_STOP on

select count(*) as n0 from agents \gset

-- ---- 6а. Первый вход создаёт аккаунт -------------------------------------
select * from app.login_by_telegram(5001::bigint, 'Новый Агент'::text,
  '00000000-0000-0000-0000-00000000b501'::uuid) \gset a1_
select test.ok(:'a1_id' is not null, 'первый вход создал аккаунт');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'агентов стало ровно на одного больше');

-- Объект во владении нового агента.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f6001', 'flat', 'sale', 'Владение 1', 70000, :'a1_id');

-- ---- 6б. Повторный вход — тот же аккаунт ---------------------------------
select * from app.login_by_telegram(5001::bigint, 'Новый Агент Переименован'::text,
  '00000000-0000-0000-0000-00000000b501'::uuid) \gset a2_

select test.eq(:'a2_id'::text, :'a1_id'::text,
  'повторный вход вернул ТОТ ЖЕ agents.id');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'дубликат аккаунта не создан');
select test.eq((select full_name from agents where id = :'a1_id'),
  'Новый Агент Переименован', 'имя обновилось на существующей строке');

-- ---- 6в. Владение объектами не потеряно ----------------------------------
select test.eq(
  (select created_by_agent_id from objects where id = '00000000-0000-0000-0000-0000000f6001')::text,
  :'a1_id'::text, 'объект остался за тем же агентом');

-- Третий вход, уже без auth_user_id: привязка не должна обнулиться.
select * from app.login_by_telegram(5001::bigint, 'Новый Агент'::text) \gset a3_
select test.eq(:'a3_auth_user_id'::text, '00000000-0000-0000-0000-00000000b501',
  'вход без auth_user_id не стирает уже установленную привязку');

-- ---- 6г. Второй аккаунт на тот же Telegram невозможен --------------------
select test.throws(
  $$insert into agents (telegram_id, full_name) values (5001, 'Двойник')$$,
  'agents_telegram_id_key',
  'второй аккаунт на тот же telegram_id отклонён');

-- ---- 6д. Аккаунт без Telegram невозможен ---------------------------------
select test.throws(
  $$insert into agents (full_name) values ('Без телеграма')$$,
  'telegram_id',
  'аккаунт без telegram_id невозможен');
