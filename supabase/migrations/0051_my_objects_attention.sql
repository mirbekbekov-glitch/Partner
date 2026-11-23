-- 0051_my_objects_attention.sql
-- Цифра «требуют внимания срочно» считает СВОИ объекты, а не всё агентство.
--
-- НЕ инвариант: ничего нового не запрещается. Исправляется поле сводки,
-- которое выбивалось из всех остальных.
--
-- Нашлось глазами, на снимке экрана. Плитка обещала «1 объект требует
-- внимания срочно», вела (после миграции 0050) ровно на него — и строка
-- оказалась чужой: объект коллеги, а кнопки действия есть только у своих.
-- То есть путь от цифры к делу обрывался на последнем шаге.

drop view if exists my_alerts_v;

create view my_alerts_v
  with (security_invoker = true) as
select
  -- ТОЛЬКО СВОИ. Раньше здесь считалось всё агентство, и это единственное
  -- поле сводки, которое так делало: соседние — воронка, подборки,
  -- уведомления, сделки — все ограничены своим. Выбивалось не по замыслу.
  --
  -- Цена выбивания видна на экране: единственный срочный объект принадлежал
  -- коллеге, кнопок действия у чужой строки нет, и агент приходил по цифре
  -- к тому, с чем ничего сделать не может. Правило репозитория говорит об
  -- этом прямо: в меню нет ни одного числа, которое не требует действия —
  -- а число, требующее действия НЕ ОТ МЕНЯ, нарушает его ровно так же.
  --
  -- Чужой подвисший объект при этом не пропадает: его видит тот, кто за него
  -- отвечает, на своей главной. Взгляд на агентство целиком — это
  -- stale_summary_v, свод по агентам; он существует с миграции 0015 и ждёт
  -- своего экрана для руководителя.
  (select count(*) from stale_objects_v s
    where s.severity = 'critical'
      and s.listing_agent_id = app.current_agent_id())::int
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
