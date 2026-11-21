-- 0040_alerts.sql
-- «Что требует внимания» считается в ОДНОМ месте.
--
-- Это не инвариант, а представление, и появилось оно из правки интерфейса:
-- меню кабинета переехало влево, и рядом с каждым разделом встала цифра —
-- «Обращения 4», «Показы 2 без исхода». До этого те же числа считала только
-- главная.
--
-- Соблазн был написать для меню второй запрос, покороче. Два запроса об
-- одном расходятся при первой же правке: кто-то поменяет порог «срочного»
-- объекта в одном месте, и меню с главной начнут показывать разные цифры —
-- а верить после этого нельзя будет ни одной. Поэтому запрос один, и обе
-- стороны берут числа отсюда.
--
-- ЧТО СЮДА ВХОДИТ. Только то, где надо что-то СДЕЛАТЬ. «Моих объектов 12» —
-- не тревога, а размер хозяйства, и в меню такой цифре не место: рядом с
-- разделом она читается как «здесь дела», которых нет. Отсюда и правило:
-- в этом представлении нет ни одного числа, которое не требует действия.

create or replace view my_alerts_v
  with (security_invoker = true) as
select
  -- Объекты: просроченный договор или давно не подтверждали.
  (select count(*) from stale_objects_v s where s.severity = 'critical')::int
    as objects_critical,

  -- Обращения, которых ещё никто не разобрал.
  (select count(*) from inquiries_v i where i.status = 'new')::int
    as inquiries_new,

  -- Карточки воронки, стоящие в колонке дольше положенного (инвариант 30).
  (select count(*) from stuck_requirements_v r
    where r.agent_id = app.current_agent_id())::int
    as funnel_stuck,

  -- Просроченные обещания (инвариант 31).
  (select count(*) from overdue_tasks_v)::int as tasks_overdue,

  -- Показы, у которых время прошло, а исхода нет (инвариант 25).
  (select count(*) from overdue_showings_v)::int as showings_overdue,

  -- Уведомления, которые канал не принял (инвариант 27).
  (select count(*) from notifications n
    where n.agent_id = app.current_agent_id()
      and n.sent_at is null and n.voided_at is null
      and n.last_error is not null)::int as notifications_stuck,

  -- Сделки, стоящие на этапе дольше отведённого (инвариант 24).
  (select count(*) from stuck_deals_v d where d.mine)::int as deals_stuck,

  -- Каналы, включённые, но неготовые: формату нужен телефон, а его нет
  -- (инвариант 28). Фид такого канала не соберётся вовсе.
  (select count(*) from channel_feeds_v c where c.enabled and not c.ready)::int
    as channels_not_ready,

  -- Администраторское. Агенту эти числа не показываются — не потому, что
  -- они секрет, а потому, что он с ними ничего не сделает.
  (select count(*) from agents a where a.status = 'pending')::int
    as agents_pending,
  (select count(*) from maintenance_health_v h
    where h.enabled and h.status <> 'в норме')::int as scheduler_broken;

comment on view my_alerts_v is
  'Что требует внимания текущего агента. Одно место для меню и для главной: два запроса об одном расходятся при первой правке. Чисел, не требующих действия, здесь нет.';

grant select on my_alerts_v to authenticated;
revoke all on my_alerts_v from anon;
