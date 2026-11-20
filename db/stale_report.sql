-- db/stale_report.sql — отчёт по подвисшим объектам в читаемом виде.
-- НЕ миграция. Нужен, пока нет кабинета: кабинет ждёт провайдера WhatsApp,
-- а объекты подвисают уже сейчас.
--
--   PGHOST=/tmp PGPORT=55432 PGUSER=postgres psql -d partner -f db/stale_report.sql
--
-- Выполняется владельцем таблиц, то есть минуя построчные политики: это
-- инструмент администратора, а не путь приложения. В кабинете те же
-- представления отдадут то же самое, но правами вошедшего агента.

\pset border 2
\pset linestyle unicode

\echo
\echo '── Свод по агентам ─────────────────────────────────────────────'

select
  coalesce(listing_agent_name, '(агент не найден)') as "агент",
  total                                            as "всего",
  critical                                         as "срочно",
  mandate_expired                                  as "договор вышел",
  needs_confirmation                               as "не подтверждали",
  no_photos                                        as "без фото",
  no_showings                                      as "без показов",
  not_published                                    as "не в каталоге"
from stale_summary_v
order by critical desc, total desc;

\echo
\echo '── Что именно подвисло ─────────────────────────────────────────'

select
  case severity when 'critical' then 'СРОЧНО' else 'внимание' end as "важность",
  address                                       as "объект",
  coalesce(listing_agent_name, '—')             as "агент",
  case when days_since_confirmed is null then '—'
       else days_since_confirmed || ' дн.' end  as "без подтверждения",
  coalesce(valid_to::text, 'бессрочно')         as "договор до",
  array_to_string(reasons, '; ')                as "причины"
from stale_objects_v
order by (severity = 'critical') desc, days_since_confirmed desc nulls last, address;

\echo
\echo 'Пороги: не подтверждали дольше'
select app.stale_after_days() as "дней", app.quiet_after_days() as "тишина, дней",
       app.mandate_warn_days() as "предупреждать за, дней";

\echo
\echo '── Сроки хранения кандидатов ───────────────────────────────────'
\echo 'Просрочка должна быть нулевой. Если нет — app.purge_candidates()'
\echo 'не вызывается по расписанию, и персональные данные лежат дольше срока.'

select
  phone_ttl_days                                  as "телефон, дней",
  record_ttl_days                                 as "запись, дней",
  phones_overdue                                  as "телефонов просрочено",
  records_overdue                                 as "записей просрочено",
  coalesce(to_char(oldest_phone_seen_at, 'DD.MM.YYYY'), '—')
                                                  as "самый старый номер"
from candidate_retention_v;
