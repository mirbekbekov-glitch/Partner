-- db/install_schedule.sql — включение планировщика. НЕ миграция.
--
-- Запускается один раз после развёртывания и повторно после любой правки
-- maintenance_jobs. Миграции этого не делают: включение pg_cron — действие
-- уровня кластера, а не схемы, и в тестовых базах расширения нет вовсе.
--
--   psql -d postgres -f db/install_schedule.sql
--
-- ЧТО НУЖНО ДО ЭТОГО.
--
-- Supabase: Dashboard → Database → Extensions → включить pg_cron. Расписание
-- при этом ведёт база postgres, она же база приложения, так что больше ничего
-- не требуется.
--
-- Свой PostgreSQL: в postgresql.conf
--
--     shared_preload_libraries = 'pg_cron'
--     cron.database_name = '<база приложения>'
--
-- и перезапуск сервера — shared_preload_libraries иначе не применится.
--
-- ЕСЛИ pg_cron НЕДОСТУПЕН, расписание ведёт внешний cron. Тогда это строка
-- в crontab, и она делает ровно то же:
--
--     17 * * * * psql "$DATABASE_URL" -c 'select app.run_maintenance_all()'
--
-- Вызывать app.run_maintenance_all() чаще, чем нужно самой частой работе,
-- безопасно: все три работы идемпотентны, и лишний проход просто ничего не
-- находит. Запись в журнал он всё равно оставит, и «в норме» будет правдой.

\set ON_ERROR_STOP on

create extension if not exists pg_cron;

select * from app.install_schedule();

\echo
\echo 'Состояние после установки:'
select job, status, cron_expression, max_silence from maintenance_health_v order by job;

\echo
\echo 'Зарегистрировано в pg_cron:'
select jobname, schedule, command, active from cron.job
 where jobname like 'partner_%' order by jobname;

\echo
\echo 'Проверка: один проход руками, чтобы журнал не был пустым.'
select * from app.run_maintenance_all();

\echo
select job, status, coalesce(to_char(last_ok_at,'DD.MM HH24:MI'),'—') as last_ok
  from maintenance_health_v order by job;
