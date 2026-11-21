-- ИНВАРИАНТ 30. Воронка — это следствие работы, а не поле, которое
--               перетаскивают.
--
--   а. Системную колонку ставит факт: показ, сделка, закрытие сделки.
--      Рукой её не поставить ничем.
--   б. Два перехода — решение агента: «разобрался» и «клиент ушёл».
--      Проигрыш требует причины.
--   в. Двигает воронку агент потребности или администратор.
--   г. Итог окончателен: из «закрыт» и «проигран» возврата нет.
--   д. Время в колонке ставит триггер, и видно, где встало.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- 30а. Колонка стоит на факте, а не на доверии
-- ===========================================================================
-- Пробы на живой базе до этой миграции: агент своей потребности ставил
-- in_deal и closed одним UPDATE. Сделки не было, мандат не закрывался,
-- комиссия не считалась — а воронка показывала сделку.

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select test.eq(
  (select status from requirements where id = :'req1'),
  'qualified'::requirement_status,
  'начинаем с разобранного клиента');

select test.throws(
  format($$update requirements set status = 'in_deal' where id = %L$$, :'req1'),
  'INVARIANT_30',
  'сделку без сделки в воронке не объявить');

select test.throws(
  format($$update requirements set status = 'closed', closed_reason = 'продал сам'
            where id = %L$$, :'req1'),
  'INVARIANT_30',
  'и закрытие сделкой, которой нет, — тоже');

select test.throws(
  format($$update requirements set status = 'in_showings' where id = %L$$, :'req1'),
  'INVARIANT_30',
  'и показы без состоявшегося показа');

select test.eq(
  (select status from requirements where id = :'req1'),
  'qualified'::requirement_status,
  'после трёх отказов клиент там же, где был');

-- А теперь то же самое, но с фактом. Карточка переезжает сама.
select * from create_match(:'obj1', :'req1') \gset m1_
select * from schedule_showing(:'m1_id', test.at_hour(0, 10)) \gset sh1_
select * from complete_showing(:'sh1_id', 'thinking') \gset done_

select test.eq(
  (select status from requirements where id = :'req1'),
  'in_showings'::requirement_status,
  'состоявшийся показ перевёл карточку в «на показах» сам');

select * from create_deal_from_match(:'m1_id') \gset d1_
select test.eq(
  (select status from requirements where id = :'req1'),
  'in_deal'::requirement_status,
  'заведённая сделка перевела карточку в «в сделке» сама');

-- ===========================================================================
-- 30б. Два перехода — решение агента
-- ===========================================================================

select * from create_requirement('rent'::deal_type, :'contact_client',
         null, null, 300, 600, '{Центр}', '{1,2}'::smallint[]) \gset new_
select test.eq(:'new_status'::text, 'new', 'новый клиент начинает с «новый»');

select test.eq(
  (select status from qualify_requirement(:'new_id')),
  'qualified'::requirement_status,
  'агент разобрался, что клиент ищет');

-- Проигрыш без причины — это молчание, а не исход.
select test.throws(
  format($$select lose_requirement(%L, '   ')$$, :'new_id'),
  'INVARIANT_30',
  'клиента без причины не проиграть');

-- Правило в триггере, а не только в функции: прямой путь закрыт тем же.
select test.throws(
  format($$update requirements set status = 'lost' where id = %L$$, :'new_id'),
  'INVARIANT_30',
  'и прямой правкой без причины тоже');

select test.eq(
  (select closed_reason from lose_requirement(:'new_id', 'купил у соседа без агента')),
  'купил у соседа без агента',
  'с причиной — проигран, и причина записана');

select test.eq(
  (select status from requirements where id = :'new_id'),
  'lost'::requirement_status,
  'карточка ушла из воронки');

-- ===========================================================================
-- 30в. Двигает агент потребности
-- ===========================================================================
-- Седьмой раз подряд: «агент» — это не «этот агент». Функция security
-- definer, политика в ней не работает, поэтому правило стоит в триггере.

select * from create_requirement('sale'::deal_type, :'contact_client',
         null, null, 50000, 90000, '{Юг}', '{2}'::smallint[]) \gset foreign_

set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select lose_requirement(%L, 'не отвечает')$$, :'foreign_id'),
  'INVARIANT_30',
  'чужого клиента по воронке не подвинуть');
select test.throws(
  format($$select qualify_requirement(%L)$$, :'foreign_id'),
  'INVARIANT_30',
  'и разобраться за чужого агента нельзя');

select test.eq(
  (select status from requirements where id = :'foreign_id'),
  'new'::requirement_status,
  'после отказов карточка на месте');

-- Но видеть её он должен: инвариант 4 прячет ИМЯ клиента, а не существование
-- работы. Карточка, пропавшая из воронки целиком, — это соврамший счёт.
select test.eq(
  (select count(*) from funnel_v where requirement_id = :'req1'),
  1::bigint,
  'чужая карточка в воронке видна');
select test.ok(
  (select contact_name from funnel_v where requirement_id = :'req1') is null,
  'а имени клиента в ней нет');

-- Администратор может: он разбирает случаи, когда агент уволился.
set request.jwt.claims = :'claims_admin';
select test.eq(
  (select status from lose_requirement(:'foreign_id', 'агент уволился, клиент не отвечает')),
  'lost'::requirement_status,
  'администратор закрывает клиента ушедшего агента');

-- ===========================================================================
-- 30г. Итог окончателен
-- ===========================================================================
-- Иначе «проиграно» в отчёте значит «пока проиграно», и сравнивать месяцы
-- между собой бессмысленно.

set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select qualify_requirement(%L)$$, :'new_id'),
  'INVARIANT_30',
  'проигранного клиента не вернуть в работу');
select test.throws(
  format($$update requirements set status = 'new' where id = %L$$, :'new_id'),
  'INVARIANT_30',
  'и в «новый» не вернуть');

-- Закрытие сделкой — и так же окончательно.
select close_deal(:'d1_id', 62000) is not null as closed \gset
select test.eq(
  (select status from requirements where id = :'req1'),
  'closed'::requirement_status,
  'закрытая сделка закрыла клиента (инвариант 2)');
select test.throws(
  format($$update requirements set status = 'qualified' where id = %L$$, :'req1'),
  'INVARIANT_30',
  'закрытого сделкой клиента не вернуть в работу');

-- Пока сделка жива, клиент из воронки не уходит: сначала сорвать сделку.
select * from create_match(:'obj2', :'req2') \gset m2_
select * from create_deal_from_match(:'m2_id') \gset d2_
select test.throws(
  format($$select lose_requirement(%L, 'передумал')$$, :'req2'),
  'INVARIANT_30',
  'клиента с живой сделкой не проиграть');

-- И назад в «разобран» тоже: пока сделка идёт, воронка обязана её показывать.
select test.throws(
  format($$update requirements set status = 'qualified' where id = %L$$, :'req2'),
  'INVARIANT_30',
  'карточку из живой сделки не вытащить назад в работу');

select fail_deal(:'d2_id', 'клиент передумал') is not null as failed \gset
select test.eq(
  (select status from requirements where id = :'req2'),
  'qualified'::requirement_status,
  'срыв сделки вернул клиента в работу сам (инвариант 24)');
select test.eq(
  (select status from lose_requirement(:'req2', 'передумал покупать вовсе')),
  'lost'::requirement_status,
  'и теперь его можно проиграть');

-- ===========================================================================
-- 30д. Сколько карточка стоит в колонке
-- ===========================================================================
-- Воронка без времени показывает количество, а спрашивают у неё всегда
-- другое: где встало.

select * from create_requirement('sale'::deal_type, :'contact_client',
         null, null, 40000, 60000, '{Север}', '{1}'::smallint[]) \gset slow_

select stage_since as t0 from requirements where id = :'slow_id' \gset
select test.ok(:'t0' is not null, 'дата входа в колонку проставлена сразу');

-- Правка условий клиента колонку не трогает: это не движение по воронке.
select update_requirement(:'slow_id', 45000, 65000) is not null as upd \gset
select test.eq(
  (select stage_since from requirements where id = :'slow_id'),
  :'t0'::timestamptz,
  'правка бюджета дату входа в колонку не двигает');

select qualify_requirement(:'slow_id') is not null as q \gset
select test.ok(
  (select stage_since from requirements where id = :'slow_id') > :'t0'::timestamptz,
  'а смена колонки — двигает');

-- Вставшая карточка видна. Срок берётся из базы, а не из экрана: иначе
-- отчёт и канбан разойдутся при первой правке.
select test.ok(
  app.requirement_stage_days('qualified') is not null,
  'у колонки «разобран» есть срок');
select test.ok(
  app.requirement_stage_days('in_deal') is null,
  'у сделки своего срока здесь нет: он в инварианте 24, и два числа об одном разошлись бы');

set role postgres;
set request.jwt.claims = '{}';
update requirements set stage_since = now() - interval '100 days' where id = :'slow_id';
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.ok(
  (select stuck from funnel_v where requirement_id = :'slow_id'),
  'простоявшая карточка помечена как вставшая');
select test.eq(
  (select count(*) from stuck_requirements_v where requirement_id = :'slow_id'),
  1::bigint,
  'и попала в отчёт о вставших');

-- Воронка — представление, а не таблица: отдельного поля «колонка» нет.
select test.eq(
  (select count(*) from information_schema.columns
    where table_name = 'requirements'
      and column_name in ('funnel_stage', 'stage', 'kanban_column', 'pipeline_stage')),
  0::bigint,
  'у потребности нет второго поля «колонка»: разойтись с работой нечему');
