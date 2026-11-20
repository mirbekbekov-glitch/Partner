-- ИНВАРИАНТ 6. Один человек — один аккаунт. Повторный вход не создаёт
--              дубликат и не теряет владение объектами.
--
-- Якорь — agents.auth_user_id (идентичность Supabase Auth), миграция 0010.
-- telegram_id необязателен, но если задан — уникален.
\i tests/actors.sql
\set ON_ERROR_STOP on

select count(*) as n0 from agents \gset

-- Пользователи Supabase. С 0027 agents.auth_user_id ссылается на auth.users,
-- поэтому строка агента без пользователя невозможна — как и на живом проекте.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000bb01', 'bb01@partner.kg'),
  ('00000000-0000-0000-0000-00000000bb02', 'bb02@partner.kg'),
  ('00000000-0000-0000-0000-00000000bb03', 'bb03@partner.kg'),
  ('00000000-0000-0000-0000-00000000bb04', 'bb04@partner.kg'),
  ('00000000-0000-0000-0000-00000000bb05', 'bb05@partner.kg'),
  ('00000000-0000-0000-0000-00000000bb06', 'bb06@partner.kg');

\set uid_new  '00000000-0000-0000-0000-00000000bb01'
\set claims_new '{"sub":"00000000-0000-0000-0000-00000000bb01","role":"authenticated"}'

-- ===========================================================================
-- Основной путь: вход по идентичности Supabase Auth, без Telegram
-- ===========================================================================

set request.jwt.claims = :'claims_new';
set role authenticated;

select * from app.ensure_agent('Новый Агент'::text) \gset a1_
select test.ok(:'a1_id' is not null, 'первый вход создал аккаунт без Telegram');
select test.eq(:'a1_status'::text, 'pending',
  'новый агент не одобрен: вход сам доступа к CRM не даёт');

-- И сразу следствие: неодобренный агент видит в agents РОВНО СЕБЯ.
-- Своя строка доступна ему всегда (политика agents_read_self, 0013) —
-- иначе он не мог бы ни увидеть свой статус, ни вписать себе имя. О
-- коллегах он при этом не узнаёт ничего: это проверяется в inv10_profile.
select test.eq(test.visible_count($$select 1 from agents$$), 1::bigint,
  'неодобренный агент видит в agents ровно себя, и никого больше');
reset role;

-- \gset СБРАСЫВАЕТ переменную, если колонка NULL, поэтому telegram_id
-- читаем из таблицы — и уже владельцем таблиц, мимо RLS.
select test.ok((select telegram_id is null from agents where id = :'a1_id'),
  'telegram_id пуст и это допустимо');

select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'агентов стало ровно на одного больше');

-- Объект во владении нового агента.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f6001', 'flat', 'sale', 'Владение 1', 70000, :'a1_id');

-- ---- Повторный вход: та же строка ----------------------------------------
set request.jwt.claims = :'claims_new';
set role authenticated;
select * from app.ensure_agent('Новый Агент Переименован'::text) \gset a2_
reset role;

select test.eq(:'a2_id'::text, :'a1_id'::text,
  'повторный вход вернул ТОТ ЖЕ agents.id');
select test.eq((select count(*) from agents)::int, (:'n0'::int + 1),
  'дубликат аккаунта не создан');
select test.eq((select full_name from agents where id = :'a1_id'),
  'Новый Агент Переименован', 'имя обновилось на существующей строке');

-- ---- Владение объектами не потеряно --------------------------------------
select test.eq(
  (select created_by_agent_id from objects where id = '00000000-0000-0000-0000-0000000f6001')::text,
  :'a1_id'::text, 'объект остался за тем же агентом');

-- ---- Вход без сессии невозможен ------------------------------------------
-- reset role роль возвращает, но удостоверение не стирает: без сброса
-- request.jwt.claims функция увидела бы прежнего агента и спокойно прошла.
reset role;
reset request.jwt.claims;
select test.throws(
  $$select app.ensure_agent('Безымянный')$$,
  'FORBIDDEN',
  'без сессии Supabase Auth аккаунт не создаётся');

-- ---- Второй аккаунт на ту же идентичность Auth невозможен ----------------
select test.throws(
  format($$insert into agents (auth_user_id, full_name) values (%L, 'Двойник')$$, :'uid_new'),
  'agents_auth_user_id_key',
  'второй аккаунт на тот же auth_user_id отклонён');

-- ===========================================================================
-- telegram_id: необязателен, но уникален
-- ===========================================================================

-- Несколько агентов без Telegram — норма: NULL уникальности не нарушает.
insert into agents (auth_user_id, full_name)
values ('00000000-0000-0000-0000-00000000bb02', 'Без телеграма один'),
       ('00000000-0000-0000-0000-00000000bb03', 'Без телеграма два');
select test.eq(
  (select count(*)::int from agents where telegram_id is null), 3,
  'агентов без telegram_id может быть несколько');

-- Но два аккаунта на один Telegram — всё так же нельзя.
insert into agents (auth_user_id, telegram_id, full_name)
values ('00000000-0000-0000-0000-00000000bb04', 7001, 'С телеграмом');
select test.throws(
  $$insert into agents (auth_user_id, telegram_id, full_name)
    values ('00000000-0000-0000-0000-00000000bb05', 7001, 'Двойник по телеграму')$$,
  'agents_telegram_id_key',
  'два аккаунта на один telegram_id отклонены');

-- ===========================================================================
-- Аккаунт без идентичности невозможен
-- ===========================================================================
-- Главная дыра, которую закрывает 0010. Строка без auth_user_id и без
-- telegram_id ни с каким входом не сопоставится, но владеть объектами может:
-- человек залогинится, получит новую строку, а объекты осиротеют.

select test.throws(
  $$insert into agents (full_name) values ('Без всякой идентичности')$$,
  'agents_has_identity',
  'аккаунт без auth_user_id и без telegram_id отклонён');

-- Отобрать ВСЕ признаки сразу нельзя. С 0027 почта тоже считается
-- идентичностью, поэтому обнуляем и её: иначе проверка пропустила бы строку,
-- в которую человек ещё может вернуться по письму.
select test.throws(
  format($$update agents set auth_user_id = null, telegram_id = null, email = null
            where id = %L$$, :'a1_id'),
  'agents_has_identity',
  'последнюю идентичность у агента отобрать нельзя');

-- ===========================================================================
-- Путь через Telegram по-прежнему работает
-- ===========================================================================
-- Вход мы через него не делаем, но если telegram_id известен, функция
-- остаётся рабочей и так же защищает от дубликата.

select * from app.login_by_telegram(5001::bigint, 'Телеграмный'::text,
  '00000000-0000-0000-0000-00000000bb06'::uuid) \gset t1_
select * from app.login_by_telegram(5001::bigint, 'Телеграмный снова'::text,
  '00000000-0000-0000-0000-00000000bb06'::uuid) \gset t2_
select test.eq(:'t2_id'::text, :'t1_id'::text,
  'повторный вход по Telegram тоже возвращает ту же строку');

-- И обе идентичности сходятся в одной строке, а не в двух.
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000bb06","role":"authenticated"}';
set role authenticated;
select * from app.ensure_agent('Через Auth'::text) \gset t3_
reset role;
select test.eq(:'t3_id'::text, :'t1_id'::text,
  'агент, завёденный по Telegram, при входе через Auth не удваивается');
