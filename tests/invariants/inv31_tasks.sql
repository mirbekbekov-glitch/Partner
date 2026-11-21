-- ИНВАРИАНТ 31. Напоминание — это обещание: у него есть срок, исполнитель и
--               предмет, и оно гаснет вместе с предметом.
--
--   а. Срок обязателен, название не пустое, исполнитель — одобренный агент.
--   б. Предмет один или ни одного.
--   в. Задачу ведёт исполнитель или постановщик; чужую не тронуть.
--   г. Закрытая задача окончательна.
--   д. Задача о закрытом предмете гаснет сама, и это триггер, а не функция.
--   е. Напоминание уходит очередью инварианта 27 со всеми её правилами.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_bakyt';

-- ===========================================================================
-- 31а. Срок, название, исполнитель
-- ===========================================================================

select * from create_task('Перезвонить Жумаеву', test.soon(), 'call',
                          null, :'contact_client') \gset tk_
select test.eq(:'tk_agent_id'::text, :'agent_bakyt'::text,
  'задача без исполнителя заводится себе');
select test.eq(:'tk_kind'::text, 'call', 'и по умолчанию это звонок');

-- Задача без срока — пожелание: просроченной она не станет никогда.
select test.throws(
  format($$insert into tasks (title, due_at, agent_id, created_by_agent_id)
           values ('позвонить когда-нибудь', null, %L, %L)$$,
         :'agent_bakyt', :'agent_bakyt'),
  'due_at',
  'задачу без срока не завести');

select test.throws(
  format($$select create_task('   ', test.soon())$$),
  'tasks_title_not_blank',
  'и без названия тоже');

-- Исполнитель — одобренный агент, а не любая строка в таблице агентов.
-- Восьмой раз подряд: «агент» — это не «любой агент».
select test.throws(
  format($$select create_task('Позвонить', test.soon(), 'call', %L)$$,
         '00000000-0000-0000-0000-0000000000a4'),
  'INVARIANT_31',
  'задачу на неодобренного агента не поставить');

-- ===========================================================================
-- 31б. Предмет один
-- ===========================================================================
-- Задача про клиента И про объект не найдётся ни там, ни там.

select test.throws(
  format($$insert into tasks (title, due_at, agent_id, created_by_agent_id,
                              contact_id, object_id)
           values ('и туда и сюда', test.soon(), %L, %L, %L, %L)$$,
         :'agent_bakyt', :'agent_bakyt', :'contact_client', :'obj1'),
  'tasks_one_subject',
  'задача о двух предметах сразу не заводится');

-- Задача, заведённая сразу сделанной, — это не работа, а запись о работе,
-- которой не было. Журнал звонков ею обесценивается целиком.
select test.throws(
  format($$insert into tasks (title, due_at, agent_id, created_by_agent_id, done_at)
           values ('как будто звонил', test.soon(), %L, %L, now())$$,
         :'agent_bakyt', :'agent_bakyt'),
  'INVARIANT_31',
  'задачу нельзя завести сразу закрытой');

-- А без предмета — можно: «съездить за ключами» тоже работа.
select * from create_task('Съездить за ключами', test.soon()) \gset keys_
select test.ok(:'keys_id' is not null, 'задача без предмета заводится');
select test.ok(
  (select subject_kind from my_tasks_v where id = :'keys_id') is null,
  'и предмета у неё нет');
select test.eq(
  (select subject_name from my_tasks_v where id = :'tk_id'),
  'Жумаев Клиент',
  'а у задачи о клиенте предмет назван одной строкой');

-- ===========================================================================
-- 31в. Задачу ведёт исполнитель или постановщик
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select complete_task(%L, 'сделал')$$, :'tk_id'),
  'INVARIANT_31',
  'чужую задачу не закрыть');
select test.eq(
  test.visible_count(format($$select 1 from tasks where id = %L$$, :'tk_id')),
  0::bigint,
  'чужая задача вообще не видна');

-- Поставленная другому — видна обоим: и тому, кто делает, и тому, кто просил.
set request.jwt.claims = :'claims_bakyt';
select * from create_task('Передать ключи Айбеку', test.soon(), 'other',
                          :'agent_aibek') \gset given_
set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format($$select 1 from tasks where id = %L$$, :'given_id')),
  1::bigint,
  'исполнитель видит поставленную ему задачу');
select test.eq(
  (select agent_id from complete_task(:'given_id', 'передал'))::text,
  :'agent_aibek'::text,
  'и закрывает её');

-- ===========================================================================
-- 31г. Закрытая задача окончательна
-- ===========================================================================
-- Иначе «сделано вчера» переписывается задним числом, и журнал звонков
-- перестаёт быть журналом.

select test.throws(
  format($$select complete_task(%L, 'ещё раз')$$, :'given_id'),
  'INVARIANT_31',
  'сделанную задачу не сделать второй раз');
select test.throws(
  format($$select reschedule_task(%L, test.soon(interval '2 hours'))$$, :'given_id'),
  'INVARIANT_31',
  'и срок ей не перенести');
select test.throws(
  format($$update tasks set title = 'другое' where id = %L$$, :'given_id'),
  'INVARIANT_31',
  'и название прямой правкой не переписать');

set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select cancel_task(%L, '  ')$$, :'keys_id'),
  'INVARIANT_31',
  'задачу без причины не снять');
select test.eq(
  (select cancel_reason from cancel_task(:'keys_id', 'ключи привезли сами')),
  'ключи привезли сами',
  'с причиной — снята');

-- ===========================================================================
-- 31д. Задача о закрытом предмете гаснет сама
-- ===========================================================================
-- Напоминание позвонить тому, кто уже купил, хуже, чем его отсутствие: оно
-- учит не читать напоминания.

select * from create_task('Позвонить по второй потребности', test.soon(), 'call',
                          null, null, :'req2') \gset r2_
select test.ok(
  (select cancelled_at from tasks where id = :'r2_id') is null,
  'пока клиент в работе, задача открыта');

select lose_requirement(:'req2', 'передумал покупать') is not null as lost \gset
select test.ok(
  (select cancelled_at from tasks where id = :'r2_id') is not null,
  'проигранный клиент снял задачу о себе');
select test.ok(
  (select cancel_reason from tasks where id = :'r2_id') like '%предмет задачи завершён%',
  'и причина названа словами, а не кодом');

-- То же для сделки, и это тот же триггер: правило держится на всех путях.
select * from create_match(:'obj1', :'req1') \gset m1_
select * from create_deal_from_match(:'m1_id') \gset d1_
select * from create_task('Собрать документы', test.soon(), 'document',
                          null, null, null, null, :'d1_id') \gset doc_

-- И вторая задача о той же сделке, но уже сделанная: она обязана остаться
-- сделанной. Снять её вместе с остальными значило бы стереть работу, которая
-- была, — а заодно нарушить «один исход» у самой задачи.
select * from create_task('Созвониться с банком', test.soon(), 'call',
                          null, null, null, null, :'d1_id') \gset bank_
select complete_task(:'bank_id', 'созвонился') is not null as bank_done \gset

select fail_deal(:'d1_id', 'клиент передумал') is not null as failed \gset
select test.ok(
  (select cancelled_at from tasks where id = :'doc_id') is not null,
  'сорванная сделка сняла открытую задачу о себе');
select test.ok(
  (select done_at from tasks where id = :'bank_id') is not null,
  'а сделанную оставила сделанной');
select test.ok(
  (select cancelled_at from tasks where id = :'bank_id') is null,
  'и не сняла её: сделанное не отменяют');

-- И для обращения.
select * from register_inquiry('site', 'demand', null, 'Нургуль', '0555 112 233',
                               'ищу двушку') \gset inq_
select * from create_task('Перезвонить по обращению', test.soon(), 'call',
                          null, null, null, null, null, :'inq_id') \gset iq_
select reject_inquiry(:'inq_id', 'реклама услуг', true) is not null as rej \gset
select test.ok(
  (select cancelled_at from tasks where id = :'iq_id') is not null,
  'разобранное обращение сняло задачу о себе');

-- Сделанную задачу закрытие предмета не трогает: сделанное не отменяют.
select test.eq(
  (select count(*) from tasks where id = :'given_id' and done_at is not null),
  1::bigint,
  'сделанная задача осталась сделанной');

-- ===========================================================================
-- 31е. Напоминание — это уведомление инварианта 27
-- ===========================================================================
-- Очередь не копируется, а расширяется предметом: иначе рядом появился бы
-- второй механизм с теми же тремя ошибками, и чинить их пришлось бы заново.

set role postgres;
set request.jwt.claims = '{}';

-- Срок наступает внутри окна напоминания.
update tasks set due_at = now() + interval '10 minutes' where id = :'tk_id';

select test.eq(app.produce_task_notifications(), 1,
  'напоминание о задаче выпущено');
select test.eq(app.produce_task_notifications(), 0,
  'и второй раз не выпускается: ДВАЖДЫ не бывает');

select test.ok(
  (select body from notifications where task_id = :'tk_id') like '%Жумаев Клиент%',
  'в тексте назван предмет: звонить без того, кому звонить, нельзя');
select test.eq(
  (select agent_id from notifications where task_id = :'tk_id')::text,
  :'agent_bakyt'::text,
  'и получатель вычислен из задачи, а не пришёл снаружи');

-- Задача закрыта — невысланное напоминание гаснет. НЕПРАВДЫ не бывает.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select complete_task(:'tk_id', 'дозвонился') is not null as done \gset
select test.ok(
  (select voided_at from notifications
    where task_id = :'tk_id' and kind = 'task_due') is not null,
  'закрытая задача погасила своё напоминание');
select test.ok(
  (select void_reason from notifications
    where task_id = :'tk_id' and kind = 'task_due') like '%сделана%',
  'и сказано почему');

-- А поправки НЕ БУДЕТ: этому агенту ещё ничего не сказали. Уведомление об
-- изменении того, о чём человек не знал, — шум, а шум учит не читать.
select test.eq(
  (select count(*) from notifications
    where task_id = :'tk_id' and kind = 'task_changed'),
  0::bigint,
  'поправки о том, чего не говорили, не уходит');

-- И новых напоминаний о закрытой задаче тоже не выпускают.
set role postgres;
set request.jwt.claims = '{}';
select test.eq(app.produce_task_notifications(), 0,
  'о сделанной задаче напоминаний больше нет');
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

-- Кому уже сказали — тому уходит поправка. И только им.
select * from create_task('Позвонить Орозову', now() + interval '10 minutes',
                          'call', :'agent_bakyt', :'contact_owner') \gset sent_

set role postgres;
set request.jwt.claims = '{}';
select app.produce_task_notifications() as produced \gset
update notifications set sent_at = now()
 where task_id = :'sent_id' and kind = 'task_due';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select reschedule_task(:'sent_id', now() + interval '3 hours') is not null as moved \gset

select test.eq(
  (select count(*) from notifications
    where task_id = :'sent_id' and kind = 'task_changed'),
  1::bigint,
  'перенос срока дал поправку тому, кому уже сказали');
select test.ok(
  (select body from notifications
    where task_id = :'sent_id' and kind = 'task_changed') like '%перенесена%',
  'и поправка говорит о переносе');

-- Отправленное не гасится: переписать прошлое нельзя.
select test.ok(
  (select voided_at from notifications
    where task_id = :'sent_id' and kind = 'task_due') is null,
  'уже отправленное напоминание не гасится');

-- А новое напоминание о НОВОМ сроке выпускается: ключ помнит время.
-- Без этого система сказала бы неправду и замолчала — самый дорогой урок
-- инварианта 27.
set role postgres;
set request.jwt.claims = '{}';
update tasks set due_at = now() + interval '10 minutes' where id = :'sent_id';
select test.eq(app.produce_task_notifications(), 1,
  'о новом сроке напоминание выпускается заново');

-- Предмет у уведомления ровно один.
select test.throws(
  format($$insert into notifications (kind, agent_id, body, due_at, about_at)
           values ('task_due', %L, 'ни о чём', now(), now())$$, :'agent_bakyt'),
  'notifications_one_subject',
  'уведомления без предмета не бывает');

-- ===========================================================================
-- 31ж. Задачи закрыты от анонима
-- ===========================================================================

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.throws(
  'select count(*) from tasks',
  'permission denied',
  'каталогу задачи агентства недоступны');
