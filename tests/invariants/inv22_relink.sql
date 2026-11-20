-- ИНВАРИАНТ 6, продолжение. Удалили пользователя в Supabase Auth — человек
--              возвращается в СВОЮ строку, а не упирается в занятую почту.
--
-- Случай найден на живом проекте: администратор удаляет человека в Supabase,
-- тот входит заново по той же почте, ensure_agent() падает с
-- «duplicate key value violates unique constraint "agents_email_key"».
-- Вход ломался навсегда, объекты оставались за строкой-сиротой.
-- Починка — 0027.
\i tests/actors.sql
\set ON_ERROR_STOP on

\set uid1 '00000000-0000-0000-0000-00000000cc01'
\set uid2 '00000000-0000-0000-0000-00000000cc02'
\set mail 'relink@partner.kg'

-- Пользователь Supabase и первый вход.
insert into auth.users (id, email) values (:'uid1', :'mail');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc01","role":"authenticated","email":"relink@partner.kg"}';
set role authenticated;
select * from app.ensure_agent('Пришёл Впервые'::text) \gset a1_
reset role; reset request.jwt.claims;

select test.eq(:'a1_email'::text, :'mail', 'первый вход записал почту из токена');

-- За агентом остаётся объект: именно его нельзя потерять.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f2201', 'flat', 'sale', 'Владение после перевхода', 81000, :'a1_id');

-- ===========================================================================
-- Администратор удаляет пользователя в Supabase Auth
-- ===========================================================================
delete from auth.users where id = :'uid1';

select test.ok((select auth_user_id is null from agents where id = :'a1_id'),
  'удаление пользователя обнулило связь, а строку агента сохранило');
select test.eq((select count(*)::int from objects where created_by_agent_id = :'a1_id'), 1,
  'объект остался за той же строкой агента');

-- ===========================================================================
-- Тот же человек входит заново: новый uid, та же почта
-- ===========================================================================
insert into auth.users (id, email) values (:'uid2', :'mail');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc02","role":"authenticated","email":"relink@partner.kg"}';
set role authenticated;
select * from app.ensure_agent() \gset a2_
reset role; reset request.jwt.claims;

select test.eq(:'a2_id'::text, :'a1_id'::text,
  'повторный вход вернул ТУ ЖЕ строку агента, а не упал на занятой почте');
select test.eq(:'a2_auth_user_id'::text, :'uid2',
  'строка привязалась к новому пользователю Supabase');
select test.eq((select count(*)::int from agents where email = :'mail'), 1,
  'дубликат по почте не создан');
select test.eq(
  (select created_by_agent_id from objects where id = '00000000-0000-0000-0000-0000000f2201')::text,
  :'a1_id'::text, 'владение объектом не потеряно');
select test.eq(:'a2_full_name'::text, 'Пришёл Впервые',
  'имя, вписанное человеком, перевход не затёр');

-- ===========================================================================
-- Чужую ЖИВУЮ запись по совпадению почты не забрать
-- ===========================================================================
-- Присвоение разрешено только для строки с пустым auth_user_id.
--
-- Двух живых пользователей с одной почтой в Supabase не бывает — почта там
-- уникальна. Но agents.email способен отстать от неё: человек сменил почту в
-- Supabase на новую, а в строке агента осталась прежняя, пока он не вошёл
-- заново. Если прежнюю почту тем временем займёт другой человек, он не должен
-- попасть в чужую запись.

\set uid4 '00000000-0000-0000-0000-00000000cc04'
\set uid5 '00000000-0000-0000-0000-00000000cc05'

-- Живой агент: в Supabase у него новая почта, в строке агента — старая.
insert into auth.users (id, email) values (:'uid4', 'moved-new@partner.kg');
insert into agents (auth_user_id, full_name, email)
  values (:'uid4', 'Сменил Почту', 'moved-old@partner.kg');

-- Другой человек заводится на освободившуюся в Supabase старую почту.
insert into auth.users (id, email) values (:'uid5', 'moved-old@partner.kg');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc05","role":"authenticated","email":"moved-old@partner.kg"}';
set role authenticated;
select test.throws(
  $$select app.ensure_agent()$$,
  'CONFLICT: почта',
  'почту живого аккаунта не присвоить: вход отказывает понятным текстом');
reset role; reset request.jwt.claims;

select test.eq((select auth_user_id from agents where email = 'moved-old@partner.kg')::text,
  :'uid4', 'живая привязка осталась за прежним пользователем');
select test.eq((select count(*)::int from agents where email = 'moved-old@partner.kg'), 1,
  'второй строки на ту же почту не появилось');

-- ===========================================================================
-- Строка без всякой идентичности по-прежнему невозможна
-- ===========================================================================
select test.throws(
  $$insert into agents (full_name) values ('Без всякой идентичности')$$,
  'agents_has_identity',
  'аккаунт без auth_user_id, telegram_id и почты отклонён');

-- А отобрать ВСЁ у существующего — тоже нельзя.
select test.throws(
  format($$update agents set auth_user_id = null, email = null where id = %L$$, :'a1_id'),
  'agents_has_identity',
  'последний признак идентичности у агента отобрать нельзя');

-- Почта одна остаётся достаточной: иначе удаление пользователя в Supabase
-- падало бы на проверке, и вход было бы не починить.
update agents set auth_user_id = null where id = :'a1_id';
select test.ok((select email is not null from agents where id = :'a1_id'),
  'строка с одной почтой допустима — на неё и опирается возврат');
