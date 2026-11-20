-- Права агента и одобрение агентов (миграция 0011).
--
-- Главное здесь — регрессия на дыру: до 0011 обычный агент мог выполнить
--   update agents set status='approved', role='admin' where auth_user_id = auth.uid()
-- и стать админом. Этот тест обязан падать, если такое снова станет возможно.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Агент не может повысить себя
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.throws(
  $$update agents set role = 'admin' where auth_user_id = auth.uid()$$,
  'permission denied',
  'агент не может переписать себе role: колонка ему не выдана');

select test.throws(
  $$update agents set status = 'approved' where auth_user_id = auth.uid()$$,
  'permission denied',
  'агент не может переписать себе status');

-- Чужого тоже.
select test.throws(
  format($$update agents set role = 'admin' where id = %L$$, :'agent_bakyt'),
  'permission denied',
  'агент не может повысить коллегу');

-- Своё имя и телефон — пожалуйста: это его данные.
update agents set full_name = 'Чынгыз Новый', phone = '+996700999888'
 where auth_user_id = auth.uid();
select test.ok(true, 'имя и телефон агент правит свободно');

select test.ok(not app.is_admin(), 'после всех попыток агент админом не стал');
reset role;

select test.eq((select role from agents where id = :'agent_chyngyz'),
  'agent'::agent_role, 'роль в базе осталась agent');
select test.eq((select full_name from agents where id = :'agent_chyngyz'),
  'Чынгыз Новый', 'а имя действительно поменялось');

-- ===========================================================================
-- Триггер держит правило и без грантов
-- ===========================================================================
-- Гранты может вернуть неосторожная миграция, поэтому проверяем, что правило
-- живо и само по себе. Выдаём колонки обратно и пробуем снова.

grant update (status, role) on agents to authenticated;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  $$update agents set role = 'admin' where auth_user_id = auth.uid()$$,
  'FORBIDDEN',
  'даже с выданным грантом триггер не даёт повысить себя');
reset role;

revoke update (status, role) on agents from authenticated;

-- ===========================================================================
-- Одобрение: только админ
-- ===========================================================================

select test.eq((select status from agents where telegram_id = 1004),
  'pending'::agent_status, 'заявка на одобрение ждёт');

-- Обычный агент одобрить не может.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
-- Ждём ИМЕННО сообщение approve_agent, а не общее FORBIDDEN. Иначе тест
-- проходит и без проверки внутри функции: отказ выдаст триггер
-- b_guard_agent_privileges, и подмену не отличить. Это нашлось мутацией.
select test.throws(
  format($$select app.approve_agent(%L)$$,
         (select id from agents where telegram_id = 1004)),
  'одобрять агентов может только админ',
  'approve_agent сам проверяет, что вызывающий — админ');

select test.throws(
  format($$select app.block_agent(%L)$$, :'agent_bakyt'),
  'блокировать агентов может только админ',
  'block_agent сам проверяет, что вызывающий — админ');

select test.throws(
  format($$select app.set_agent_role(%L, 'admin')$$, :'agent_bakyt'),
  'роль агента меняет только админ',
  'set_agent_role сам проверяет, что вызывающий — админ');
-- И представления экрана для него пусто.
select test.eq(test.visible_count($$select 1 from admin_agents_v$$), 0::bigint,
  'не админу экран одобрения пуст');
reset role;

-- Админ может.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select id as pending_id from agents where telegram_id = 1004 \gset
select * from app.approve_agent(:'pending_id') \gset ap_
select test.eq(:'ap_status'::text, 'approved', 'админ одобрил заявку');

select test.ok(test.visible_count($$select 1 from admin_agents_v$$) >= 5,
  'админу экран одобрения показывает агентов');

-- На экране видно, кто это: почта, и сколько человек наработал.
select test.eq(
  (select email from admin_agents_v where id = :'agent_aibek'),
  'aibek@partner.kg', 'экран показывает почту агента');
select test.eq(
  (select objects_count from admin_agents_v where id = :'agent_aibek'), 3::bigint,
  'экран показывает, сколько у агента объектов');

-- ===========================================================================
-- Блокировка и роли
-- ===========================================================================

select * from app.block_agent(:'agent_chyngyz') \gset bl_
select test.eq(:'bl_status'::text, 'blocked', 'админ заблокировал агента');

select * from app.set_agent_role(:'agent_bakyt', 'admin'::agent_role) \gset sr_
select test.eq(:'sr_role'::text, 'admin', 'админ выдал роль админа');

-- ---- Последнего админа запереть нельзя -----------------------------------
select * from app.set_agent_role(:'agent_bakyt', 'agent'::agent_role);
select test.throws(
  format($$select app.set_agent_role(%L, 'agent')$$, :'agent_admin'),
  'LAST_ADMIN',
  'последнего админа нельзя разжаловать');
select test.throws(
  format($$select app.block_agent(%L)$$, :'agent_admin'),
  'LAST_ADMIN',
  'последнего админа нельзя заблокировать');
reset role;

-- ===========================================================================
-- Заблокированный агент теряет доступ
-- ===========================================================================
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.ok(app.current_agent_id() is null,
  'заблокированный агент перестал быть действующим');
select test.eq(test.visible_count($$select 1 from requirements$$), 0::bigint,
  'заблокированный агент CRM не видит');
reset role;

-- ===========================================================================
-- Первый админ заводится прямым доступом к базе
-- ===========================================================================
-- Пока админа нет, одобрять некому, поэтому прямой доступ (psql,
-- service_role, миграция) правило обходит сознательно. Сессии там нет,
-- поэтому auth.uid() пуст и триггер пропускает.
reset request.jwt.claims;
update agents set role = 'admin', status = 'approved' where id = :'agent_chyngyz';
select test.eq((select role from agents where id = :'agent_chyngyz'),
  'admin'::agent_role, 'прямым доступом к базе первого админа завести можно');

-- ===========================================================================
-- Вход по почте подхватывает адрес
-- ===========================================================================
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-00000000cc01', 'novyi@partner.kg');

set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc01","role":"authenticated"}';
set role authenticated;
select * from app.ensure_agent() \gset ne_
select test.eq(:'ne_email'::text, 'novyi@partner.kg',
  'вход по почте: адрес подхвачен из auth.users');
select test.eq(:'ne_full_name'::text, 'novyi@partner.kg',
  'имени ещё нет, поэтому вместо него почта');
select test.eq(:'ne_status'::text, 'pending',
  'новый агент ждёт одобрения');

-- Повторный вход имя не затирает.
reset role;
update agents set full_name = 'Настоящее Имя' where id = :'ne_id';
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000cc01","role":"authenticated"}';
set role authenticated;
select * from app.ensure_agent() \gset ne2_
select test.eq(:'ne2_full_name'::text, 'Настоящее Имя',
  'повторный вход без имени существующее имя не затирает');
reset role;

-- ===========================================================================
-- Функции схемы app агенту не выданы (0025)
-- ===========================================================================
-- В Postgres EXECUTE на новую функцию по умолчанию выдан PUBLIC, поэтому все
-- 52 функции схемы app были вызываемы любым вошедшим агентом, а
-- `grant ... to service_role` ничего не ограничивал. Проверено до 0025:
-- обычный агент вызовом app.expire_mandates() погасил 4 мандата и опустошил
-- каталог — опубликованных было 3, стало 0.

-- Чынгыз к этому месту теста уже стал админом (его заводили первым админом
-- прямым доступом к базе), поэтому берём агента, который им не становился.
set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- Два слоя, и проверяем оба. Слой первый — грант.
select test.throws(
  $$select app.claim_notifications(10)$$,
  'permission denied',
  'очередь напоминаний агенту не выдана');
select test.throws(
  $$select app.jsonb_diff('{}'::jsonb, '{}'::jsonb)$$,
  'permission denied',
  'внутренние помощники схемы app агенту не выданы');

-- Слой второй — проверка ВНУТРИ функции. Она и есть основная для тех
-- функций, которые админ может запускать руками: роль authenticated в
-- Postgres одна на всех вошедших, грантом админа от агента не отличить.
select test.throws(
  $$select app.expire_mandates()$$,
  'работа расписания, а не агента',
  'агент не гасит мандаты агентства, хотя грант у роли есть');
select test.throws(
  $$select app.backfill_missing_mandates()$$,
  'разовая работа админа',
  'и не запускает массовое создание договоров');
reset role;

-- Каталог цел.
select test.ok((select count(*) > 0 from objects where publication_state = 'published'),
  'опубликованные объекты на месте');

-- Админу эти функции доступны.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(app.expire_mandates() >= 0, 'админ может погасить просроченные мандаты');
reset role;
