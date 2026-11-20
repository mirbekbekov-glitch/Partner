-- ИНВАРИАНТ 16. Каждая обязательная работа по расписанию оставляет запись о
--               каждом запуске — удачном и неудачном; журнал запусков не
--               переписывается; работа, молчащая дольше своего срока, видна
--               как задержка, а не как тишина.
--
-- Проверяется не pg_cron: он чужой код, и чинить его не нам. Проверяется то,
-- что молчание планировщика ЗАМЕТНО. Расписание, о котором узнают через месяц
-- по жалобе собственника, хуже отсутствующего: отсутствующее хотя бы никого
-- не вводит в заблуждение.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 16а. До первого запуска планировщик считается молчащим ---------------
set role authenticated;
set request.jwt.claims = :'claims_admin';

select test.eq(
  (select count(*)::int from maintenance_health_v where status = 'ни разу не запускалась'),
  3, 'все три работы числятся ни разу не запущенными');

select test.eq(app.maintenance_overdue(), 3,
  'планировщик не в норме, пока не было ни одного запуска');

-- ---- 16б. Запуск оставляет запись с результатом ---------------------------
-- «Запустилось» и «сработало» — разные вещи, поэтому в журнале лежит не
-- отметка, а результат: сколько мандатов истекло, сколько телефонов удалено.
set role postgres;
select test.eq(
  ((select app.run_maintenance('purge_candidates')) ->> 'ok')::boolean,
  true, 'работа выполнена');

select test.ok(
  (select result ? 'phones_removed' and result ? 'candidates_removed'
     from maintenance_runs where job = 'purge_candidates'),
  'в журнале лежит результат, а не отметка о запуске');

select test.eq(
  (select count(*)::int from maintenance_runs where job = 'purge_candidates' and ok),
  1, 'запуск записан один раз');

-- ---- 16в. Падение работы записывается, а не теряется ----------------------
-- Нужна работа, которая падает по-настоящему. Ломать для этого
-- app.expire_mandates() — плохая мысль: тест, который переписывает рабочую
-- функцию, должен её потом вернуть, и первая версия этого теста вернула её
-- неправильно (своей выдумкой вместо настоящей) и упала на следующей строке.
--
-- Поэтому падение берётся штатное: работа объявлена в таблице, а кода для
-- неё нет. Для run_maintenance это тот же путь — исключение внутри работы.
set role postgres;
insert into maintenance_jobs (job, description, cron_expression, max_silence)
values ('_без_кода', 'объявлена в таблице, а кода нет', '0 * * * *', interval '1 hour');

select test.eq(
  ((select app.run_maintenance('_без_кода')) ->> 'ok')::boolean,
  false, 'упавшая работа возвращает ok = false, а не падает сама');

select test.ok(
  (select error like '%нет кода%' from maintenance_runs where job = '_без_кода'),
  'причина падения записана в журнал');

-- ---- 16г. Падение одной работы не уносит остальные ------------------------
select test.eq(
  (select count(*)::int from app.run_maintenance_all() where ok),
  3, 'три настоящие работы прошли, несмотря на сломанную четвёртую');

select test.eq(
  (select count(*)::int from app.run_maintenance_all() where not ok),
  1, 'сломанная работа вернулась с ошибкой, а не прервала проход');

select test.eq(
  (select status from maintenance_health_v where job = '_без_кода'),
  'падает с первого запуска', 'сломанная работа видна как падающая');

-- Удалить её нельзя: журнал на неё ссылается, и внешний ключ это запрещает.
-- Так и задумано — запись о запуске не должна осиротеть от правки
-- расписания. Поэтому работа выключается, а не удаляется.
set role postgres;
select test.throws(
  $$delete from maintenance_jobs where job = '_без_кода'$$,
  'violates foreign key constraint "maintenance_runs_job_fkey"',
  'работу с историей запусков не удалить из расписания');

update maintenance_jobs set enabled = false where job = '_без_кода';

-- ---- 16д. Журнал только дописывается --------------------------------------
-- Запись о падении, которую можно поправить, не доказывает ничего.
select test.throws(
  $$update maintenance_runs set ok = true, error = null where not ok$$,
  'INVARIANT_16: журнал запусков только дописывается',
  'запись в журнале запусков не переписать');

select test.throws(
  $$delete from maintenance_runs$$,
  'INVARIANT_16: журнал запусков только дописывается',
  'запись из журнала запусков не удалить');

-- ---- 16е. Молчание дольше срока видно как задержка ------------------------
-- Срок молчания задан с запасом к расписанию: минута опоздания не поломка,
-- сутки тишины у суточной задачи — поломка.
set role postgres;
insert into maintenance_runs (job, started_at, finished_at, ok, result)
values ('release_stale_claims', now() - interval '5 hours', now() - interval '5 hours',
        true, '{"claims_released": 0}'::jsonb);

set role authenticated;
select test.eq(
  (select status from maintenance_health_v where job = 'release_stale_claims'),
  'в норме', 'свежий запуск держит работу в норме, даже если есть старый');

set role postgres;
-- Теперь убираем свежие запуски и оставляем только пятичасовой: срок
-- молчания у этой работы три часа.
insert into maintenance_jobs (job, description, cron_expression, max_silence)
values ('_молчащая', 'работа для проверки задержки', '0 * * * *', interval '1 hour');
insert into maintenance_runs (job, started_at, finished_at, ok, result)
values ('_молчащая', now() - interval '4 hours', now() - interval '4 hours', true, '{}'::jsonb);

set role authenticated;
select test.eq(
  (select status from maintenance_health_v where job = '_молчащая'),
  'задержка', 'работа, молчащая дольше своего срока, видна как задержка');

select test.ok(
  (select silence > max_silence from maintenance_health_v where job = '_молчащая'),
  'в представлении видно, насколько именно работа опоздала');

select test.ok(app.maintenance_overdue() > 0,
  'одно число говорит, что планировщик не в порядке');

-- ---- 16ж. Выключенная работа не считается поломкой ------------------------
set role postgres;
update maintenance_jobs set enabled = false where job = '_молчащая';
set role authenticated;
select test.eq(
  (select status from maintenance_health_v where job = '_молчащая'),
  'выключена', 'выключенная работа не числится сломанной');
select test.eq(app.maintenance_overdue(), 0,
  'после выключения планировщик снова в норме');

-- И вот ровно поэтому выключение попадает в журнал. Иначе самый простой
-- способ заглушить весь инвариант 16 — не ломать его, а тихо снять галочку:
-- «выключена» поломкой не считается.
set role postgres;
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'maintenance_job'
      and diff -> 'enabled' ->> 'to' = 'false') >= 1,
  'выключение работы записано в журнал: кто и когда заглушил расписание');

set role postgres;
select test.throws(
  $$select app.run_maintenance('_молчащая')$$,
  'INVARIANT_16: работа _молчащая выключена',
  'выключенную работу не запустить');

-- ---- 16з. Неизвестную работу не запустить ---------------------------------
select test.throws(
  $$select app.run_maintenance('rm -rf')$$,
  'INVARIANT_16: работа rm -rf не объявлена в maintenance_jobs',
  'работа не из таблицы не запускается');

-- ---- 16и. Ручной запуск — только администратору ---------------------------
-- Плановые работы меняют данные всего агентства: освобождают кандидатов,
-- снимают объекты с публикации. Это не кнопка рядового агента.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  $$select * from run_maintenance_now()$$,
  'FORBIDDEN: плановые работы запускает администратор',
  'рядовой агент не запускает плановые работы');

set request.jwt.claims = :'claims_admin';
select test.eq(
  (select count(*)::int from run_maintenance_now() where ok),
  3, 'администратор запускает все работы руками');

select test.eq(
  ((select ok from run_maintenance_now('purge_candidates'))),
  true, 'администратор запускает одну работу по имени');

-- ---- 16к. Расписание не меняют через PostgREST ----------------------------
-- Отказ приходит раньше RLS: роли выдан только select, и до построчных
-- политик дело не доходит. Проверяется именно эта причина, а не любая:
-- ожидание общего «отказано» уже дважды в этом проекте пропускало мутации,
-- которые ломали одно, а падали на другом.
select test.throws(
  $$update maintenance_jobs set cron_expression = '* * * * *'$$,
  'permission denied for table maintenance_jobs',
  'расписание не переписать из кабинета');
select test.throws(
  $$insert into maintenance_jobs (job, description, cron_expression, max_silence)
    values ('своя', 'чужая работа', '* * * * *', interval '1 hour')$$,
  'permission denied for table maintenance_jobs',
  'работу в расписание не добавить из кабинета');
select test.throws(
  $$insert into maintenance_runs (job, started_at, finished_at, ok)
    values ('purge_candidates', now(), now(), true)$$,
  'permission denied for table maintenance_runs',
  'запись в журнал запусков не подделать из кабинета');

-- ---- 16л. Планировщик недоступен каталогу и сборщику ----------------------
set role postgres; set role anon;
select test.throws(
  $$select app.run_maintenance_all()$$,
  'permission denied for function run_maintenance_all',
  'аноним не запускает плановые работы');
select test.throws(
  $$select * from maintenance_runs$$,
  'permission denied for table maintenance_runs',
  'аноним не читает журнал запусков');

set role postgres; set role collector;
select test.throws(
  $$select app.install_schedule()$$,
  'permission denied for function install_schedule',
  'сборщик не трогает расписание');
