-- 0049_work_from_funnel.sql
-- Работа начинается с карточки клиента, а не с раздела меню. НЕ инвариант:
-- ничего нового здесь не запрещается, меняется место, откуда работу делают.
--
-- Повод — вопрос владельца продукта: «это же всё в воронке должно быть?».
-- Проверка показала, что за вопросом стоит дефект: карточка клиента в
-- воронке НИКУДА НЕ ВЕЛА. На ней были две кнопки перехода и напоминание, а
-- чтобы собрать подборку или назначить показ по тому же человеку, агент
-- уходил в «Клиенты» и искал его заново. Воронка показывала работу, но не
-- давала её делать.
--
-- ГРАНИЦА, которая тут важна. Подборка, показ и напоминание — действия ПО
-- КЛИЕНТУ, и начинаться им с его карточки. А «Задачи» и «Показы» списками
-- остаются: это не про клиента, это про ДЕНЬ. Утром агент смотрит «что у
-- меня сегодня» — пересечение всех клиентов сразу, — и обходить ради этого
-- тридцать карточек он не станет. К тому же задача бывает про объект и про
-- обращение, и в воронку клиентов такая не помещается вовсе.
--
-- «Подборки» отдельным разделом — вот это лишнее. Подборка существует
-- только при клиенте; единственное, что в ней межклиентского, — «отправил, а
-- он не открыл», и это тревога на главной, а не пункт меню.

-- Столбец встаёт в середину, а create or replace переименовывать их не
-- умеет. Пересоздаём.
drop view if exists my_alerts_v;

create view my_alerts_v
  with (security_invoker = true) as
select
  (select count(*) from stale_objects_v s where s.severity = 'critical')::int
    as objects_critical,

  (select count(*) from inquiries_v i where i.status = 'new')::int
    as inquiries_new,

  (select count(*) from stuck_requirements_v r
    where r.agent_id = app.current_agent_id())::int
    as funnel_stuck,

  (select count(*) from overdue_tasks_v)::int as tasks_overdue,

  (select count(*) from overdue_showings_v)::int as showings_overdue,

  -- Отправленные подборки, которых клиент не открыл (инвариант 36). Это и
  -- есть вся межклиентская ценность подборок: вопрос «он вообще смотрел?».
  -- Отозванные не считаются: по ним ответа и не ждут.
  (select count(*) from my_selections_v s
    where s.agent_id = app.current_agent_id()
      and s.sent_at is not null
      and s.first_opened_at is null
      and s.revoked_at is null
      and (s.expires_at is null or s.expires_at > now()))::int
    as selections_unopened,

  (select count(*) from notifications n
    where n.agent_id = app.current_agent_id()
      and n.sent_at is null and n.voided_at is null
      and n.last_error is not null)::int as notifications_stuck,

  (select count(*) from stuck_deals_v d where d.mine)::int as deals_stuck,

  (select count(*) from channel_feeds_v c where c.enabled and not c.ready)::int
    as channels_not_ready,

  (select count(*) from agents a where a.status = 'pending')::int
    as agents_pending,
  (select count(*) from maintenance_health_v h
    where h.enabled and h.status <> 'в норме')::int as scheduler_broken;

comment on view my_alerts_v is
  'Один запрос на всё, что требует внимания: и счётчики в меню, и плитки на главной. Два разных запроса под одни и те же числа однажды разошлись бы.';

grant select on my_alerts_v to authenticated;
revoke all on my_alerts_v from anon;
