-- Расписание инварианта 1.
-- В контейнере pg_cron нет, поэтому здесь проверяется ровно то, что должно
-- работать без него: миграция не падает, а состояние расписания видно.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Миграция применилась (иначе шаблон бы не собрался) и функция есть.
select test.ok(
  (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'schedule_health'),
  'app.schedule_health() создана даже без pg_cron');

-- Проверка честно сообщает, что расписания нет.
select test.ok(
  (select not ok from app.schedule_health() where check_name = 'pg_cron установлен'),
  'проверка видит отсутствие pg_cron');
select test.ok(
  (select not ok from app.schedule_health() where check_name = 'задание expire-mandates'),
  'проверка видит отсутствие задания');

-- И отдельно следит за симптомом: просроченные активные мандаты.
select test.ok(
  (select ok from app.schedule_health()
    where check_name = 'нет просроченных активных мандатов'),
  'просроченных активных мандатов сейчас нет');

update mandates set valid_from = current_date - 10, valid_to = current_date - 1
 where id = :'mandate3';

select test.ok(
  (select not ok from app.schedule_health()
    where check_name = 'нет просроченных активных мандатов'),
  'проверка ловит просроченный активный мандат');
select test.ok(
  (select detail like 'просрочено мандатов: 1%' from app.schedule_health()
    where check_name = 'нет просроченных активных мандатов'),
  'проверка называет количество просроченных мандатов');

-- Ручной вызов снимает симптом и, по инварианту 1, объект с публикации.
select test.eq(app.expire_mandates(), 1, 'expire_mandates() погасила мандат');
select test.ok(
  (select ok from app.schedule_health()
    where check_name = 'нет просроченных активных мандатов'),
  'после вызова симптом снят');
select test.eq(
  (select publication_state from objects where id = :'obj3'),
  'withdrawn'::publication_state,
  'и объект ушёл из каталога');

-- Доступна агенту: состояние расписания не секрет.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok((select count(*) = 3 from app.schedule_health()),
  'агент может проверить состояние расписания');
reset role;
