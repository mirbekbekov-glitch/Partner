-- ИНВАРИАНТ 8. Показ существует только внутри подбора.
--              Состоявшийся показ двигает подбор и потребность сам.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- ---- 8а. Показа вне подбора не существует --------------------------------
select test.throws(
  format($$insert into showings (match_id, agent_id, scheduled_at, created_by_agent_id)
           values (null, %L, now(), %L)$$, :'agent_bakyt', :'agent_bakyt'),
  'INVARIANT_8',
  'показ без подбора отклонён');

-- ---- 8б. Назначенный показ двигает подбор --------------------------------
select * from create_match(:'obj1', :'req1') \gset m1_
select test.eq(:'m1_status'::text, 'proposed', 'подбор создан в proposed');

select * from schedule_showing(:'m1_id', test.at_hour(2), 'подъезд со двора') \gset sh1_
select test.eq(:'sh1_status'::text, 'scheduled', 'показ назначен');
select test.eq(:'sh1_agent_id'::text, :'agent_bakyt'::text, 'показ проводит текущий агент');

select test.eq(
  (select status from matches where id = :'m1_id'), 'showing_scheduled'::match_status,
  'назначенный показ перевёл подбор в showing_scheduled');

select test.ok(
  (select showing_at from matches where id = :'m1_id') is not null,
  'matches.showing_at посчитан из таблицы показов');

-- ---- 8в. Показ проводит только участник подбора ---------------------------
-- Чынгыз не ведёт клиента, не создавал подбор и не listing-агент мандата.
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select schedule_showing(%L, test.at_hour(1))$$, :'m1_id'),
  'INVARIANT_8',
  'посторонний агент показ назначить не может');
set request.jwt.claims = :'claims_bakyt';

-- ---- 8г. Состоявшийся показ двигает подбор и потребность -----------------
-- Закрыть можно только состоявшийся показ (инвариант 25), поэтому сначала
-- он наступает: клиент приехал на час раньше договорённого.
select reschedule_showing(:'sh1_id', test.at_hour(-1, 16)) is not null as came \gset
select * from complete_showing(:'sh1_id', 'wants_bargain', 'готов, но просит минус 3000') \gset done1_
select test.eq(:'done1_status'::text, 'done', 'показ завершён');
select test.ok(:'done1_done_at' is not null, 'время показа зафиксировано');

select test.eq(
  (select status from matches where id = :'m1_id'), 'showing_done'::match_status,
  'состоявшийся показ перевёл подбор в showing_done');

select test.eq(
  (select status from requirements where id = :'req1'), 'in_showings'::requirement_status,
  'состоявшийся показ перевёл потребность в in_showings');

-- Результат у состоявшегося показа обязателен. Нужен ещё назначенный показ:
-- завершённый второй раз не завершить.
-- Показ в прошлом: инвариант 25 не даёт закрыть ненаступивший показ, а
-- проверяется здесь обязательность результата, а не время.
select * from schedule_showing(:'m1_id', test.at_hour(-1, 11)) \gset sh2_
select test.throws(
  format($$select complete_showing(%L, null)$$, :'sh2_id'),
  'INVARIANT_8',
  'показ без результата завершить нельзя');

-- Та же проверка на уровне схемы: прямой UPDATE тоже не проходит.
select test.throws(
  format($$update showings set status = 'done', done_at = now() where id = %L$$, :'sh2_id'),
  'check constraint',
  'состоявшийся показ без результата отклонён и прямым UPDATE');

select * from cancel_showing(:'sh2_id', 'проверка завершена') \gset sh2c_

-- ---- 8д. Подбор показа подменить нельзя ----------------------------------
select * from create_match(:'obj2', :'req2') \gset m2_
select test.throws(
  format($$update showings set match_id = %L where id = %L$$, :'m2_id', :'sh1_id'),
  'INVARIANT_8',
  'подбор у показа подменить нельзя');

-- ---- 8е. По отклонённому подбору показа нет ------------------------------
update matches set status = 'rejected', rejection_reason = 'не подошёл этаж'
 where id = :'m2_id';
select test.throws(
  format($$select schedule_showing(%L, test.at_hour(1))$$, :'m2_id'),
  'INVARIANT_8',
  'показ по отклонённому подбору невозможен');

-- ---- 8ж. Отмена возвращает подбор из showing_scheduled -------------------
select * from create_match(:'obj3', :'req2') \gset m3_
-- Потребность req2 закрыта? Нет: закрывается только сделкой. Проверим путь.
select * from schedule_showing(:'m3_id', test.at_hour(3)) \gset sh3_
select test.eq(
  (select status from matches where id = :'m3_id'), 'showing_scheduled'::match_status,
  'второй подбор тоже ушёл в showing_scheduled');

select * from cancel_showing(:'sh3_id', 'клиент перенёс') \gset cancel3_
select test.eq(:'cancel3_status'::text, 'cancelled', 'показ отменён');
select test.eq(
  (select status from matches where id = :'m3_id'), 'interested'::match_status,
  'отмена единственного показа вернула подбор в interested');
select test.ok(
  (select showing_at from matches where id = :'m3_id') is null,
  'showing_at очищен вместе с отменой');

-- ---- 8з. Видимость показа: участники подбора, не вся команда --------------
-- Айбек не ведёт клиента, но он listing-агент мандата на объект, значит
-- отвечает перед собственником за показы и видит их.
set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format($$select 1 from showings where id = %L$$, :'sh1_id')), 1::bigint,
  'listing-агент мандата видит показ своего объекта');

set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  test.visible_count(format($$select 1 from showings where id = %L$$, :'sh1_id')), 0::bigint,
  'посторонний агент показа не видит');

set request.jwt.claims = :'claims_admin';
select test.eq(
  test.visible_count(format($$select 1 from showings where id = %L$$, :'sh1_id')), 1::bigint,
  'админ видит показ');

-- ---- 8и. Показ попал в журнал (инвариант 7) ------------------------------
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'showing' and entity_id = :'sh1_id') >= 2,
  'создание и завершение показа записаны в журнал');
