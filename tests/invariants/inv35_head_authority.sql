-- ИНВАРИАНТ 35. Руководитель отвечает за всё в своём агентстве — и может всё.
--
--   а. Руководитель делает за агента то, что делает агент: двигает объект по
--      этапам, заключает и подтверждает договор, публикует, двигает клиента
--      по воронке, закрывает задачи, передаёт работу.
--   б. Граница агентства остаётся: руководитель чужого агентства — никто.
--   в. Рядовой агент начальником не становится.
--   г. Ждущий одобрения с ролью руководителя — не руководитель.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role postgres;
set request.jwt.claims = '{}';
update agents set role = 'head' where id = :'agent_aibek';

-- Соседнее агентство со своим руководителем.
insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000ab01', 'Соседи');
insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id)
values ('00000000-0000-0000-0000-0000000000c1', 'boss2@partner.kg', '+996700350001',
        '00000000-0000-0000-0000-0000000000d1', 'Чужой руководитель', 'head', 'approved',
        '00000000-0000-0000-0000-00000000ab01');
\set claims_boss2 '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}'

-- Бакыт заводит свою работу.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from register_object('flat', 'sale', 'Бакытова 1, кв. 5', 65000,
                              null, 'Собственник Бакыта', '0555 500 001') \gset bo_
select * from create_requirement('sale'::deal_type, null, 'Клиент Бакыта',
         '0555 500 002', 50000, 90000, '{Центр}', '{2}'::smallint[]) \gset br_
select * from create_task('Позвонить клиенту', test.soon(), 'call') \gset bt_

-- ===========================================================================
-- 35а. Руководитель делает за агента
-- ===========================================================================
-- Проба до этого инварианта показала семь отказов подряд: ровно то, ради
-- чего руководитель и нужен — разобрать за агентом, который уволился,
-- заболел или забыл.

set request.jwt.claims = :'claims_aibek';
select test.ok(app.is_head(), 'Айбек — руководитель');

select test.eq(
  (select owner_stage from set_owner_stage(:'bo_id', 'called')),
  'called'::owner_stage,
  'руководитель двигает чужой объект по этапам');

select test.eq(
  (select contract_confirmed from sign_mandate(:'bo_id', 'exclusive', null, null, true)),
  true,
  'и заключает по нему договор');

select test.eq(
  (select publication_state from publish_object(:'bo_id')),
  'published'::publication_state,
  'и публикует его');

select test.eq(
  (select status from qualify_requirement(:'br_id')),
  'qualified'::requirement_status,
  'двигает чужого клиента по воронке');

select test.eq(
  (select budget_max from update_requirement(:'br_id', 60000, 100000)),
  100000::numeric,
  'правит условия чужого клиента');

select test.ok(
  (select done_at from complete_task(:'bt_id', 'сделал за коллегу')) is not null,
  'закрывает чужую задачу');

select test.eq(
  (select agent_id from transfer_requirement(:'br_id', :'agent_chyngyz')),
  :'agent_chyngyz'::uuid,
  'и передаёт чужого клиента другому агенту');

-- ===========================================================================
-- 35б. Граница агентства остаётся
-- ===========================================================================
-- Инвариант 33 не ослабляется: «всё» — это всё в СВОЁМ агентстве.

set request.jwt.claims = :'claims_boss2';
select test.ok(app.is_head(), 'у соседей свой руководитель');

select test.throws(
  format($$select set_owner_stage(%L, 'visited')$$, :'bo_id'),
  'INVARIANT_22',
  'чужой объект руководитель соседнего агентства не двигает');
select test.throws(
  format($$select publish_object(%L)$$, :'obj2'),
  'INVARIANT_22',
  'и не публикует');
select test.throws(
  format($$select update_requirement(%L, 1, 2)$$, :'req2'),
  'INVARIANT_22',
  'и чужого клиента не правит');
select test.eq(
  test.visible_count(format($$select 1 from requirements where id = %L$$, :'req2')),
  0::bigint,
  'он их даже не видит');

-- ===========================================================================
-- 35в. Рядовой агент начальником не становится
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
select test.ok(not app.is_head(), 'рядовой агент не руководитель');
select test.ok(not app.commands_agent(:'agent_bakyt'), 'и не начальник коллеге');
select test.throws(
  format($$select set_owner_stage(%L, 'visited')$$, :'bo_id'),
  'INVARIANT_22',
  'и чужой объект не двигает');

-- ===========================================================================
-- 35г. Ждущий одобрения — не руководитель
-- ===========================================================================

set role postgres;
set request.jwt.claims = '{}';
update agents set role = 'head' where id = '00000000-0000-0000-0000-0000000000a4';

set role authenticated;
set request.jwt.claims = :'claims_pending';
select test.ok(not app.is_head(), 'ждущий одобрения не руководитель, даже с ролью');
select test.ok(
  not app.commands_object(:'bo_id'),
  'и ничем не командует');
