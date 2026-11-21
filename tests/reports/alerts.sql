-- ОТЧЁТ. «Что требует внимания»: одно место для меню и для главной.
--
-- Не инвариант: правил этот запрос не устанавливает. Но и не декорация —
-- на нём стоят цифры рядом с разделами меню, и если он соврёт, агент
-- пойдёт разбирать то, чего нет, или не пойдёт туда, где горит.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.eq(
  (select count(*) from my_alerts_v), 1::bigint,
  'представление отдаёт ровно одну строку: это сводка, а не список');

-- ---------------------------------------------------------------------------
-- Числа означают «надо что-то сделать»
-- ---------------------------------------------------------------------------
-- В сценарии приёмки обращений нет вовсе — значит и тревоги быть не должно.
-- Проверка не вакуумная: дальше обращение заводится, и число меняется.

select test.eq(
  (select inquiries_new from my_alerts_v), 0,
  'неразобранных обращений нет');

select * from register_inquiry('site', 'demand', null, 'Нургуль', '0555 112 233',
                               'ищу двушку') \gset inq_
select test.eq(
  (select inquiries_new from my_alerts_v), 1,
  'новое обращение сразу видно в сводке');

select qualify_inquiry(:'inq_id') is not null as q \gset
select test.eq(
  (select inquiries_new from my_alerts_v), 0,
  'разобранное — больше не висит');

-- ---------------------------------------------------------------------------
-- Просроченная задача видна её исполнителю, и только ему
-- ---------------------------------------------------------------------------
-- Сводка идёт под правами читающего (security_invoker), поэтому «чужое» в
-- неё не попадает само собой, а не потому, что запрос это помнит.

select * from create_task('Перезвонить клиенту', test.soon(), 'call') \gset t_
set role postgres;
set request.jwt.claims = '{}';
update tasks set due_at = now() - interval '2 hours' where id = :'t_id';

set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select tasks_overdue from my_alerts_v), 1,
  'просроченная задача попала в сводку исполнителя');

set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select tasks_overdue from my_alerts_v), 0,
  'а в сводку чужого агента — нет');

-- ---------------------------------------------------------------------------
-- В сводке нет чисел, которые ничего не требуют
-- ---------------------------------------------------------------------------
-- «Моих объектов 12» — размер хозяйства, а не дело. Рядом с разделом меню
-- такая цифра читается как «здесь надо что-то сделать», и это враньё.

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'my_alerts_v'
      and column_name in ('objects_mine', 'objects_published', 'requirements_mine',
                          'deals_open', 'showings_upcoming', 'candidates_mine')),
  0,
  'в сводке нет чисел, не требующих действия');

-- ---------------------------------------------------------------------------
-- Каталогу сводка недоступна
-- ---------------------------------------------------------------------------

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.throws(
  'select count(*) from my_alerts_v',
  'permission denied',
  'анониму сводка кабинета недоступна');
