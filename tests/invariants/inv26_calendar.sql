-- ИНВАРИАНТ 26. Назначенный показ помещается в календарь — и в срок договора.
--
--   а. Показ назначают в часы, когда открывают дверь.
--   б. Показ назначают, пока на объект есть договор: не раньше его начала и
--      не позже его конца.
--   в. История этим правилам не подчиняется: состоявшийся показ записывается
--      любой датой и в любой час.
--   г. Перенос проверяется так же, как назначение.
--   д. Два агента по одному объекту в один час не запрещены, но видны.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select * from create_match(:'obj1', :'req1') \gset m1_

-- Час по Бишкеку в метку времени: правило живёт в поясе агентства, и тест
-- обязан ходить тем же путём, а не через часы сервера.
\set at_hour '((current_date + 3)::timestamp + time '

-- ===========================================================================
-- 26а. Часы показов
-- ===========================================================================

select test.throws(
  format($$select schedule_showing(%L, %s'03:00') at time zone 'Asia/Bishkek')$$,
         :'m1_id', :'at_hour'),
  'INVARIANT_26',
  'показ в три часа ночи отклонён');

select test.throws(
  format($$select schedule_showing(%L, %s'23:30') at time zone 'Asia/Bishkek')$$,
         :'m1_id', :'at_hour'),
  'INVARIANT_26',
  'показ в половине двенадцатого ночи отклонён');

-- Границы открыты: раз число названо функцией, оно и есть правило.
select * from schedule_showing(:'m1_id',
  ((current_date + 3)::timestamp + app.showing_opens()) at time zone 'Asia/Bishkek') \gset open_
select test.eq(:'open_status'::text, 'scheduled', 'показ ровно в час открытия назначается');

select * from schedule_showing(:'m1_id',
  ((current_date + 4)::timestamp + app.showing_closes()) at time zone 'Asia/Bishkek') \gset close_
select test.eq(:'close_status'::text, 'scheduled', 'показ ровно в час закрытия назначается');

-- А минутой позже — нет: закрытие это последний час НАЧАЛА показа.
select test.throws(
  format($$select schedule_showing(%L,
            ((current_date + 5)::timestamp + app.showing_closes() + interval '1 minute')
              at time zone 'Asia/Bishkek')$$, :'m1_id'),
  'INVARIANT_26',
  'минутой позже закрытия показ уже не назначить');

select test.ok(
  app.showing_opens() < app.showing_closes(),
  'окно показов не пустое: на нём держатся и правило, и сетка календаря');

-- ===========================================================================
-- 26б. Срок договора
-- ===========================================================================
-- Договор на obj2 кончается через 5 дней.

set role postgres;
set request.jwt.claims = '{}';
update mandates set valid_to = current_date + 5
 where object_id = :'obj2' and status = 'active';
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select * from create_match(:'obj2', :'req1') \gset m2_

select test.eq(
  (select valid_to from app.mandate_window(:'obj2')),
  (current_date + 5)::date,
  'срок договора читается');

-- У объекта бывают прошлые договоры, и срок берётся у ДЕЙСТВУЮЩЕГО, а не у
-- первого попавшегося: иначе прошлогодний договор запретил бы сегодняшний
-- показ.
set role postgres;
set request.jwt.claims = '{}';
insert into mandates (object_id, kind, valid_from, valid_to, start_price,
                      listing_agent_id, contract_confirmed, status)
values (:'obj1', 'non_exclusive', current_date - 400, current_date - 300, 80000,
        :'agent_aibek', true, 'expired');
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.eq(
  (select count(*) from app.mandate_window(:'obj1')),
  1::bigint,
  'при двух договорах на объекте действующий один');
select test.ok(
  (select valid_to from app.mandate_window(:'obj1')) is null,
  'и срок берётся у него, а не у прошлогоднего');

select test.eq(
  (select status from schedule_showing(:'m2_id',
     ((current_date + 4)::timestamp + time '15:00') at time zone 'Asia/Bishkek')),
  'scheduled'::showing_status,
  'показ внутри срока договора назначается');

select test.throws(
  format($$select schedule_showing(%L,
            ((current_date + 20)::timestamp + time '15:00') at time zone 'Asia/Bishkek')$$,
         :'m2_id'),
  'INVARIANT_26',
  'показ после окончания договора отклонён');

-- Договор ещё не начался: агент не имеет права показывать объект, и это
-- хуже остальных случаев — он приведёт клиента в чужую квартиру.
set role postgres;
set request.jwt.claims = '{}';
update mandates set valid_from = current_date + 10, valid_to = null
 where object_id = :'obj3' and status = 'active';
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select * from create_match(:'obj3', :'req2') \gset m3_
select test.throws(
  format($$select schedule_showing(%L,
            ((current_date + 2)::timestamp + time '15:00') at time zone 'Asia/Bishkek')$$,
         :'m3_id'),
  'INVARIANT_26',
  'показ до начала договора отклонён');

select test.eq(
  (select status from schedule_showing(:'m3_id',
     ((current_date + 12)::timestamp + time '15:00') at time zone 'Asia/Bishkek')),
  'scheduled'::showing_status,
  'после начала договора тот же показ назначается');

-- Бессрочный договор далёкое будущее не запрещает: ограничение приходит из
-- договора, а не из головы.
select test.ok(
  (select valid_to from app.mandate_window(:'obj3')) is null,
  'договор на obj3 бессрочный');
select test.eq(
  (select status from schedule_showing(:'m3_id',
     ((current_date + 200)::timestamp + time '15:00') at time zone 'Asia/Bishkek')),
  'scheduled'::showing_status,
  'при бессрочном договоре показ через полгода назначается');

-- ===========================================================================
-- 26в. История правилам календаря не подчиняется
-- ===========================================================================
-- Состоявшийся показ это запись о том, что было. Запретом там ничего не
-- чинится, а перенос истории сломался бы на первой же строке.

insert into showings (match_id, agent_id, scheduled_at, done_at, status, outcome,
                      created_by_agent_id)
values (:'m1_id', :'agent_bakyt',
        ((current_date - 10)::timestamp + time '03:00') at time zone 'Asia/Bishkek',
        ((current_date - 10)::timestamp + time '04:00') at time zone 'Asia/Bishkek',
        'done', 'thinking', :'agent_bakyt');
select test.eq(
  (select count(*) from showings
    where match_id = :'m1_id' and status = 'done'
      and (scheduled_at at time zone 'Asia/Bishkek')::time = time '03:00'),
  1::bigint,
  'состоявшийся показ записывается и в три часа ночи: это история');

-- ===========================================================================
-- 26г. Перенос проверяется так же
-- ===========================================================================

select test.throws(
  format($$select reschedule_showing(%L,
            ((current_date + 6)::timestamp + time '04:00') at time zone 'Asia/Bishkek')$$,
         :'open_id'),
  'INVARIANT_26',
  'перенести показ на ночь нельзя');

select test.throws(
  format($$select reschedule_showing(%L,
            ((current_date + 30)::timestamp + time '15:00') at time zone 'Asia/Bishkek')$$,
         (select id from showings where match_id = :'m2_id' and status = 'scheduled')),
  'INVARIANT_26',
  'перенести показ за срок договора нельзя');

-- ===========================================================================
-- 26д. Две группы у одной двери: не запрет, а видимость
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
select * from schedule_showing(:'m1_id', :'open_scheduled_at'::timestamptz + interval '20 minutes')
  \gset clash_
select test.eq(:'clash_status'::text, 'scheduled',
  'второй агент по тому же объекту в тот же час НЕ запрещён');

select test.ok(
  exists (select 1 from showing_clashes_v
           where id = :'clash_id' and other_id = :'open_id'),
  'столкновение видно в отчёте — с обеих сторон');

select test.eq(
  (select other_agent_name from showing_clashes_v where id = :'clash_id'),
  'Бакыт',
  'в отчёте названо, кто ещё придёт к этой двери');

-- Один агент, один объект, подряд — это обычная работа (инвариант 25 её
-- разрешает), и столкновением она не считается. Иначе отчёт ругался бы на
-- двух клиентов, которых агент показывает одному и тому же подъезду.
set request.jwt.claims = :'claims_bakyt';
select * from schedule_showing(:'m1_id', :'open_scheduled_at'::timestamptz + interval '30 minutes')
  \gset back_
select test.eq(:'back_status'::text, 'scheduled', 'два показа подряд по одному объекту назначены');
select test.ok(
  not exists (select 1 from showing_clashes_v where agent_id = other_agent_id),
  'сам с собой агент не сталкивается');

-- Разные объекты в один час — не столкновение: дверей две, и у каждой свой
-- агент. Бакыт показывает obj2, Айбек в тот же час obj1.
set request.jwt.claims = :'claims_aibek';
select * from schedule_showing(:'m1_id',
  ((current_date + 4)::timestamp + time '15:10') at time zone 'Asia/Bishkek') \gset cross_
select test.ok(
  exists (select 1 from showings s join matches m on m.id = s.match_id
           where s.id = :'cross_id' and m.object_id = :'obj1'),
  'Айбек показывает obj1 в тот же час, когда Бакыт показывает obj2');
select test.ok(
  not exists (
    select 1 from showing_clashes_v c
      join matches m  on m.id  = c.match_id
      join matches om on om.id = (select match_id from showings where id = c.other_id)
     where m.object_id <> om.object_id),
  'показы по разным объектам столкновением не считаются');

-- Разошлись по времени — столкновения нет.
select reschedule_showing(:'clash_id', :'open_scheduled_at'::timestamptz + interval '3 hours')
  is not null as moved \gset
select test.ok(
  not exists (select 1 from showing_clashes_v where id = :'clash_id'),
  'разведённые по времени показы столкновением быть перестают');

-- Снятый показ к двери не придёт, и в отчёте его быть не должно.
select reschedule_showing(:'clash_id', :'open_scheduled_at'::timestamptz + interval '20 minutes')
  is not null as back \gset
select test.ok(
  exists (select 1 from showing_clashes_v where id = :'clash_id'),
  'вернули время — вернулось и столкновение');
select cancel_showing(:'clash_id', 'договорились по телефону') is not null as off \gset
select test.ok(
  not exists (select 1 from showing_clashes_v
               where id = :'clash_id' or other_id = :'clash_id'),
  'снятый показ в столкновениях не считается — ни с одной стороны');

-- ===========================================================================
-- Права
-- ===========================================================================

set role postgres;
set request.jwt.claims = '{}';
select test.eq(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_name = 'showing_clashes_v'),
  0::bigint,
  'анониму календарь агентства не открыт');
