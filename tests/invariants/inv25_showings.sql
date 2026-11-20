-- ИНВАРИАНТ 25. Показ это встреча, а не запись в журнале.
--
--   а. Показ двигают участники подбора, проводящий агент и админ.
--   б. Назначить встречу в прошлое нельзя; записать состоявшийся показ можно.
--   в. Показ не проходит раньше, чем наступит.
--   г. Агент не бывает в двух местах одновременно.
--   е. Неявка это не отмена.
--   ж. Назначенный показ без исхода попадает в просроченные.
--   д. Показ, который уже не состоится, снимается сам, а не живёт вечно.
--      Идёт последним: каскад закрывает мандаты и потребности, и после него
--      заводить новые показы уже не на чем.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- Бакыт ведёт клиента (req1), Айбек — listing-агент всех трёх мандатов.
select * from create_match(:'obj1', :'req1') \gset m1_
select * from schedule_showing(:'m1_id', test.at_hour(2), 'подъезд со двора') \gset sh1_

-- ===========================================================================
-- 25а. Показ двигают участники подбора
-- ===========================================================================
-- Главная дыра инварианта 25. Таблица закрыта политиками: посторонний не
-- видит показа. А функции доступа объявлены security definer, RLS не видят и
-- спрашивают только «есть ли вошедший агент». Пятый случай, когда «агент»
-- оказывается не «этот агент».

set request.jwt.claims = :'claims_chyngyz';

select test.eq(
  test.visible_count(format($$select 1 from showings where id = %L$$, :'sh1_id')),
  0::bigint,
  'посторонний агент чужого показа не видит');

select test.throws(
  format($$select cancel_showing(%L, 'мне так удобнее')$$, :'sh1_id'),
  'INVARIANT_25',
  'посторонний агент чужой показ не отменяет');

select test.throws(
  format($$select mark_no_show(%L)$$, :'sh1_id'),
  'INVARIANT_25',
  'посторонний агент неявку по чужому показу не отмечает');

select test.throws(
  format($$select reschedule_showing(%L, test.at_hour(3))$$, :'sh1_id'),
  'INVARIANT_25',
  'посторонний агент чужой показ не переносит');

-- Прямой UPDATE закрыт политикой: ни строки.
update showings set cancel_reason = 'тронул мимо функции' where id = :'sh1_id';
select test.eq(
  (select count(*) from showings where cancel_reason = 'тронул мимо функции'),
  0::bigint,
  'прямой UPDATE чужого показа не меняет ни строки');

-- Триггер пропускает изменение без вошедшего агента — это путь миграций,
-- засева и обслуживания. Проверяем, что посторонний на него не встанет:
-- обнулив claims, он теряет и функции (require_agent), и таблицу (политика).
set request.jwt.claims = '{}';
select test.throws(
  format($$select cancel_showing(%L, 'я теперь система')$$, :'sh1_id'),
  'FORBIDDEN',
  'обнулив claims, посторонний теряет функции доступа');
update showings set cancel_reason = 'я теперь система' where id = :'sh1_id';
select test.eq(
  (select count(*) from showings where cancel_reason = 'я теперь система'),
  0::bigint,
  'обнулив claims, посторонний теряет и прямой доступ к таблице');

-- А участники — могут. Бакыт ведёт клиента, Айбек отвечает за объект.
set request.jwt.claims = :'claims_aibek';
select * from reschedule_showing(:'sh1_id', test.at_hour(3)) \gset r1_
select test.eq(
  (select scheduled_at from showings where id = :'sh1_id'),
  :'r1_scheduled_at'::timestamptz,
  'listing-агент объекта показ переносит');

set request.jwt.claims = :'claims_admin';
select test.eq(
  (select status from reschedule_showing(:'sh1_id', test.at_hour(4))),
  'scheduled'::showing_status,
  'админ показ переносит');

-- Проводящий агент назван в правиле отдельно, и это не украшение: после
-- передачи объекта (инвариант 23) он перестаёт быть участником подбора, а
-- исход своего показа записать обязан он.
-- Подбор заводит агент потребности (инвариант 20), показ по нему проводит
-- Айбек как listing-агент объекта.
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj2', :'req1') \gset m2_
set request.jwt.claims = :'claims_aibek';
select * from schedule_showing(:'m2_id', test.at_hour(-1, 16), 'показ Айбека') \gset sh2_
select transfer_object(:'obj2', :'agent_chyngyz') is not null as moved \gset
select test.ok(
  not app.is_match_participant(:'m2_id', :'agent_aibek'),
  'после передачи объекта Айбек больше не участник подбора');
select test.eq(
  (select outcome from complete_showing(:'sh2_id', 'thinking', 'взял паузу')),
  'thinking'::showing_outcome,
  'проводящий агент закрывает свой показ и после передачи объекта');

-- Путь без вошедшего агента нужен не каскаду — у того своё исключение, — а
-- миграциям и засеву: перенос истории показов делает владелец таблиц, и
-- вошедшего агента у него нет. Без этой ветки миграция не смогла бы писать
-- в собственную таблицу.
set role postgres;
set request.jwt.claims = '{}';
insert into showings (match_id, agent_id, scheduled_at, created_by_agent_id)
values (:'m1_id', :'agent_bakyt', test.at_hour(14), :'agent_bakyt');
select test.eq(
  (select count(*) from showings
    where match_id = :'m1_id' and scheduled_at > test.at_hour(13)),
  1::bigint,
  'без вошедшего агента показ заводят миграции и засев');
set role authenticated;

-- ===========================================================================
-- 25б. Встреча не назначается в прошлое, история записывается
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';

select test.throws(
  format($$select schedule_showing(%L, '2019-01-01 10:00+06')$$, :'m1_id'),
  'INVARIANT_25',
  'показ нельзя назначить на 2019 год');

select test.throws(
  format($$select reschedule_showing(%L, test.at_hour(-10))$$, :'sh1_id'),
  'INVARIANT_25',
  'перенести показ в далёкое прошлое тоже нельзя');

-- Забытый утренний показ записывают вечером, и это норма: ограничение
-- касается НАЗНАЧЕННОЙ встречи, а не записанной истории.
select test.eq(
  (select status from schedule_showing(:'m1_id', test.at_hour(-1, 11), 'записал задним числом')),
  'scheduled'::showing_status,
  'показ час назад назначить можно: агент дозаписывает свой день');

insert into showings (match_id, agent_id, scheduled_at, done_at, status, outcome,
                      created_by_agent_id)
values (:'m1_id', :'agent_bakyt', now() - interval '10 days', now() - interval '10 days',
        'done', 'rejected', :'agent_bakyt');
select test.ok(
  (select count(*) from showings
    where match_id = :'m1_id' and status = 'done'
      and scheduled_at < now() - interval '9 days') = 1,
  'состоявшийся показ записывается любой прошлой датой: это история');

-- ===========================================================================
-- 25в. Показ не проходит раньше, чем наступит
-- ===========================================================================
-- Так чистят список: закрыть сегодня всё, что назначено на неделю вперёд.

select * from schedule_showing(:'m1_id', test.at_hour(6), 'через неделю') \gset sh3_

-- Сообщение базы — это то, что читает агент: кабинет показывает его как есть,
-- сняв префикс (web/app/cabinet/actions.ts, humanize). Поэтому проверяется и
-- формулировка: из триггера агент услышал бы про done_at, которого не вводил.
select test.throws(
  format($$select complete_showing(%L, 'interested')$$, :'sh3_id'),
  'ещё не наступил',
  'будущий показ закрыть нельзя, и сказано это словами агента');

-- Правило держит триггер, а не только функция: мимо функции тоже нельзя.
select test.throws(
  format($$update showings set status = 'done', done_at = now(), outcome = 'interested'
            where id = %L$$, :'sh3_id'),
  'INVARIANT_25',
  'и прямым UPDATE будущий показ закрыть нельзя');

select test.eq(
  (select status from complete_showing(
     (select id from reschedule_showing(:'sh3_id', test.at_hour(-1, 13))),
     'interested', 'понравилось')),
  'done'::showing_status,
  'после переноса на прошедшее время показ закрывается');

-- ===========================================================================
-- 25г. Агент не бывает в двух местах одновременно
-- ===========================================================================

select * from schedule_showing(:'m1_id', test.at_hour(8), 'опора') \gset base_
select * from create_match(:'obj3', :'req2') \gset m3_

select test.throws(
  format($$select schedule_showing(%L, %L::timestamptz + interval '20 minutes')$$,
         :'m3_id', :'base_scheduled_at'),
  'INVARIANT_25',
  'второй показ по ДРУГОМУ объекту в тот же час отклонён');

select test.eq(
  (select status from schedule_showing(
     :'m1_id', :'base_scheduled_at'::timestamptz + interval '30 minutes')),
  'scheduled'::showing_status,
  'по ТОМУ ЖЕ объекту подряд можно: агент уже там');

select test.eq(
  (select status from schedule_showing(
     :'m3_id', :'base_scheduled_at'::timestamptz + interval '2 hours')),
  'scheduled'::showing_status,
  'другой объект через два часа можно: пересечения нет');

-- Правило про агента, а не про час: другой агент в то же время не мешает.
set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select agent_id from schedule_showing(
     :'m3_id', :'base_scheduled_at'::timestamptz + interval '25 minutes')),
  :'agent_aibek'::uuid,
  'другому агенту то же время не мешает: занят не час, а агент');
set request.jwt.claims = :'claims_bakyt';

-- Снятый показ освобождает время. Берём свободный вечер, чтобы проверять
-- именно освобождение, а не соседние показы этого теста.
select * from schedule_showing(:'m1_id', test.at_hour(9), 'вечерний') \gset ev_
select test.throws(
  format($$select schedule_showing(%L, %L::timestamptz + interval '20 minutes')$$,
         :'m3_id', :'ev_scheduled_at'),
  'INVARIANT_25',
  'пока показ назначен, время агента занято');
select cancel_showing(:'ev_id', 'перенесли на словах') is not null as off \gset
select test.eq(
  (select status from schedule_showing(
     :'m3_id', :'ev_scheduled_at'::timestamptz + interval '20 minutes')),
  'scheduled'::showing_status,
  'снятый показ время агента больше не занимает');

-- ===========================================================================
-- 25е. Неявка это не отмена
-- ===========================================================================

-- Свежий подбор без прошлых показов: create_match возвращает существующий,
-- если такая пара уже есть, и состоявшийся показ по нему испортил бы проверку.
select * from create_match(:'obj3', :'req1') \gset m7_
select * from schedule_showing(:'m7_id', test.at_hour(-1, 18)) \gset sh7_
select test.eq(
  (select status from mark_no_show(:'sh7_id', 'не приехал, телефон молчит')),
  'no_show'::showing_status,
  'неявка это своё состояние, а не отмена');

select test.eq(
  (select status from matches where id = :'m7_id'),
  'interested'::match_status,
  'после неявки подбор не врёт о назначенном показе');

select test.throws(
  format($$select mark_no_show(%L)$$, :'sh7_id'),
  'отметить неявку нельзя',
  'неявку дважды не отметить');

-- Собственнику отмена и неявка говорят разное: первое про агентство, второе
-- про спрос. До инварианта 25 они складывались в одно число.
set request.jwt.claims = :'claims_aibek';
select * from issue_owner_access(:'obj3', :'contact_owner') \gset oa_
select (app.owner_report(:'oa_token') -> 'showings') as rep \gset
select test.eq(((:'rep'::jsonb) ->> 'no_show')::int, 1,
  'отчёт собственнику считает неявки отдельно');
select test.eq(((:'rep'::jsonb) ->> 'cancelled')::int, 0,
  'неявка не попадает в отмены');

-- ===========================================================================
-- 25ж. Назначенный показ без исхода попадает в просроченные
-- ===========================================================================
-- Молчание о показе не значит, что он прошёл хорошо.

set request.jwt.claims = :'claims_bakyt';
select * from schedule_showing(:'m1_id', test.at_hour(-1, 20), 'забыл закрыть') \gset old_

select test.ok(
  exists (select 1 from overdue_showings_v where id = :'old_id'),
  'показ, у которого время прошло, а исхода нет, виден в просроченных');

select test.ok(
  not exists (select 1 from overdue_showings_v where status <> 'scheduled'),
  'закрытые, снятые и неявки в просроченные не попадают');

select test.ok(
  not exists (select 1 from overdue_showings_v
               where scheduled_at > now() - app.showing_slot()),
  'показ, который ещё идёт, не просрочен: отбор держится на app.showing_slot()');

select test.ok(
  app.showing_slot() > interval '0',
  'срок показа задан: на нём держатся и пересечения, и просрочка');

-- ===========================================================================
-- 25д. Показ, который уже не состоится, снимается сам
-- ===========================================================================
-- До инварианта 25 такой показ был бессмертен: завершить нельзя (проверка на
-- закрытую потребность), снять нельзя (та же проверка), удалить нельзя. Он
-- оставался в календаре агента и в отчёте собственнику как «назначено 1» по
-- проданной квартире. Навсегда, даже для админа.

-- Подбор отклонён — его показы сняты.
select * from create_match(:'obj3', :'req1') \gset m4_
select * from schedule_showing(:'m4_id', test.at_hour(20)) \gset sh4_
update matches set status = 'rejected', rejection_reason = 'клиенту не подошёл район'
 where id = :'m4_id';
select test.eq(
  (select status from showings where id = :'sh4_id'),
  'cancelled'::showing_status,
  'отклонённый подбор снимает свои назначенные показы');
select test.ok(
  (select cancel_reason from showings where id = :'sh4_id') is not null,
  'у снятого базой показа есть причина, а не пустое поле');

-- Договор кончился — показы объекта сняты, причём без вошедшего агента:
-- мандаты истекают по расписанию, а не руками.
select * from create_match(:'obj3', :'req2') \gset m5_
select * from schedule_showing(:'m5_id', test.at_hour(25)) \gset sh5_

set role postgres;
set request.jwt.claims = '{}';
update mandates set valid_from = current_date - 30, valid_to = current_date - 1
 where object_id = :'obj3' and status = 'active';
select test.ok(app.expire_mandates() >= 1, 'мандат истёк по расписанию');
select test.eq(
  (select status from showings where id = :'sh5_id'),
  'cancelled'::showing_status,
  'истёкший договор снимает назначенные показы объекта — обслуживанием, без агента');

-- Сделка закрыта — объект ушёл, клиент нашёл, и показы обеих сторон сняты.
-- Это ДВА разных каскада, и проверять их надо по отдельности, иначе один
-- прикроет отсутствие другого: показ по проданному объекту снимает договор,
-- а показ того же клиента по ЧУЖОМУ объекту — только закрытая потребность.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj1', :'req2') \gset m6_
select * from schedule_showing(:'m6_id', test.at_hour(30)) \gset sh6_

-- У obj2 договор действует: его показ переживёт закрытие мандата obj1.
select * from create_match(:'obj2', :'req2') \gset m8_
select * from schedule_showing(:'m8_id', test.at_hour(35)) \gset sh8_

select * from create_deal_from_match(:'m6_id') \gset d6_
select close_deal(:'d6_id', 90000) is not null as closed \gset

select test.eq(
  (select status from showings where id = :'sh6_id'),
  'cancelled'::showing_status,
  'закрытая сделка снимает назначенные показы своего объекта');
select test.ok(
  (select cancel_reason from showings where id = :'sh6_id') like '%договор%',
  'и снимает их именно закрытием договора объекта');

select test.eq(
  (select status from showings where id = :'sh8_id'),
  'cancelled'::showing_status,
  'показ того же клиента по другому объекту тоже снят: он уже нашёл');
select test.ok(
  (select cancel_reason from showings where id = :'sh8_id') like '%потребность%',
  'и снят он закрытием потребности — договор того объекта в порядке');
select test.eq(
  (select status from mandates where object_id = :'obj2' and status = 'active'),
  'active'::mandate_status,
  'договор другого объекта при этом остался действующим');

select test.eq(
  (select count(*) from showings where status = 'scheduled'
     and match_id in (select id from matches where object_id = :'obj1')),
  0::bigint,
  'по проданному объекту назначенных показов не остаётся');

-- Сметать показы пачкой агенту незачем: это внутренность каскада, и наружу
-- она не выдана (инвариант 15).
select test.throws(
  format($$select app.cancel_impossible_showings(p_object_id => %L)$$, :'obj2'),
  'permission denied',
  'агент каскадом снятия показов пользоваться не может');

-- Каскад проверяет невозможность для КАЖДОГО показа, а не верит аргументу:
-- у obj2 договор действует, его показ остаётся на месте.
select * from schedule_showing(:'m2_id', test.at_hour(40), 'ещё состоится') \gset keep_
set role postgres;
set request.jwt.claims = '{}';
select test.eq(
  app.cancel_impossible_showings(p_object_id => :'obj2'),
  0,
  'каскад не снимает показы, которые ещё могут состояться');
select test.eq(
  (select status from showings where id = :'keep_id'),
  'scheduled'::showing_status,
  'возможный показ после вызова каскада остался назначенным');
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
