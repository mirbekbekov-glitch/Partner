-- Напоминания о задачах (миграция 0024).
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Что считается поводом напомнить
-- ===========================================================================

-- Фикстуры вставляются владельцем таблиц: колонка id агенту не выдана
-- (её генерирует база), а тестам нужны известные идентификаторы.
insert into activities (id, kind, entity_type, entity_id, agent_id, body, due_at) values
  ('00000000-0000-0000-0000-0000000a0001', 'task', 'object', :'obj1', :'agent_aibek',
   'позвонить собственнику', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000a0002', 'showing', 'object', :'obj1', :'agent_aibek',
   'показ с клиентом', now() + interval '3 hours');

-- А это поводом НЕ является.
insert into activities (id, kind, entity_type, entity_id, agent_id, body, due_at) values
  ('00000000-0000-0000-0000-0000000a0003', 'note', 'object', :'obj1', :'agent_aibek',
   'заметка со сроком', now() - interval '1 hour'),      -- заметка: срока по сути нет
  ('00000000-0000-0000-0000-0000000a0004', 'task', 'object', :'obj1', :'agent_aibek',
   'без срока', null),                                    -- срока нет
  ('00000000-0000-0000-0000-0000000a0005', 'task', 'object', :'obj1', :'agent_aibek',
   'далеко', now() + interval '10 days');                  -- за горизонтом
insert into activities (id, kind, entity_type, entity_id, agent_id, body, due_at, done) values
  ('00000000-0000-0000-0000-0000000a0006', 'task', 'object', :'obj1', :'agent_aibek',
   'уже сделано', now() - interval '1 day', true);         -- выполнено

select count(*) from app.enqueue_due_reminders();
select test.eq((select count(*)::int from notifications), 2,
  'в очередь попали только задача и показ со сроком');
select test.eq(
  (select kind from notifications where activity_id = '00000000-0000-0000-0000-0000000a0001'),
  'overdue'::notification_kind, 'просроченная задача помечена как просроченная');
select test.eq(
  (select kind from notifications where activity_id = '00000000-0000-0000-0000-0000000a0002'),
  'due_soon'::notification_kind, 'показ со скорым сроком помечен как «скоро»');

-- Заметка, задача без срока, далёкая и выполненная — не попали.
select test.eq(
  (select count(*)::int from notifications
    where activity_id in ('00000000-0000-0000-0000-0000000a0003',
                          '00000000-0000-0000-0000-0000000a0004',
                          '00000000-0000-0000-0000-0000000a0005',
                          '00000000-0000-0000-0000-0000000a0006')), 0,
  'заметка, задача без срока, далёкая и выполненная поводом не являются');

-- ---- Текст напоминания собран в базе ------------------------------------
select test.ok(
  (select body like 'Просрочено: задача по «Чүй 120, кв. 5»%позвонить собственнику%Срок:%'
     from notifications where activity_id = '00000000-0000-0000-0000-0000000a0001'),
  'текст содержит повод, объект, саму задачу и срок');

-- ===========================================================================
-- Дважды не напомним
-- ===========================================================================
-- Расписание может сработать повторно, маршрут — упасть на середине.

select app.enqueue_due_reminders();
select app.enqueue_due_reminders();
select test.eq((select count(*)::int from notifications), 2,
  'повторные прогоны расписания дубликатов не создают');

-- ===========================================================================
-- Выполнил или сдвинул срок — напоминать незачем
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
update activities set done = true where id = '00000000-0000-0000-0000-0000000a0001';
reset role;

select test.eq(
  (select status from notifications where activity_id = '00000000-0000-0000-0000-0000000a0001'),
  'cancelled'::notification_status,
  'выполненная задача снимает напоминание из очереди');

-- И повторный прогон не ставит его заново: запись осталась.
select app.enqueue_due_reminders();
select test.eq(
  (select status from notifications where activity_id = '00000000-0000-0000-0000-0000000a0001'),
  'cancelled'::notification_status, 'и прогон расписания его не возвращает');

-- Сдвиг срока: прежнее напоминание больше не про него, ставится заново.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
update activities set due_at = now() + interval '1 hour'
 where id = '00000000-0000-0000-0000-0000000a0002';
reset role;
select test.eq(
  (select count(*)::int from notifications
    where activity_id = '00000000-0000-0000-0000-0000000a0002'), 0,
  'сдвиг срока убирает прежнее напоминание');
select app.enqueue_due_reminders();
select test.eq(
  (select count(*)::int from notifications
    where activity_id = '00000000-0000-0000-0000-0000000a0002'), 1,
  'и на новый срок напоминание ставится заново');

-- ===========================================================================
-- Агенту без Telegram доставлять нечем — и это видно
-- ===========================================================================
-- Молчание здесь хуже всего: агент думает, что напоминание придёт.

reset role;
update agents set telegram_id = null where id = :'agent_bakyt';
insert into activities (id, kind, entity_type, entity_id, agent_id, body, due_at)
values ('00000000-0000-0000-0000-0000000a0007', 'task', 'object', :'obj2',
        :'agent_bakyt', 'задача без канала', now() - interval '1 hour');

select app.enqueue_due_reminders();
select test.eq(
  (select status from notifications where activity_id = '00000000-0000-0000-0000-0000000a0007'),
  'no_channel'::notification_status,
  'без привязанного Telegram запись помечена «нечем доставить», а не потеряна');
select test.ok(
  (select channel is null from notifications
    where activity_id = '00000000-0000-0000-0000-0000000a0007'),
  'канал не выбран');

-- Привязал админ — следующий прогон доставит.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.eq((set_agent_telegram(:'agent_bakyt', 7777::bigint)).telegram_id, 7777::bigint,
  'админ привязывает Telegram агенту');
reset role;

-- ---- Привязать может только админ ---------------------------------------
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  format($$select set_agent_telegram(%L, 8888)$$, :'agent_chyngyz'),
  'только админ',
  'агент не привязывает Telegram сам: нужна проверка через бота, которой нет');
reset role;

-- ===========================================================================
-- Заблокированному и неодобренному не напоминаем
-- ===========================================================================

-- reset role возвращает роль, но НЕ стирает удостоверение: без сброса
-- claims триггер из 0011 видит не-админа и правку статуса не пропускает.
reset role;
reset request.jwt.claims;
delete from notifications where true;
update agents set status = 'blocked' where id = :'agent_bakyt';
select app.enqueue_due_reminders();
select test.eq(
  (select count(*)::int from notifications where agent_id = :'agent_bakyt'), 0,
  'заблокированному агенту напоминания не ставятся');
update agents set status = 'approved' where id = :'agent_bakyt';

-- ===========================================================================
-- Выдача пачки отправщику: двойная отправка исключена
-- ===========================================================================

delete from notifications where true;
select app.enqueue_due_reminders();
select count(*) as queued from notifications where status = 'pending' \gset
select test.ok(:'queued'::int > 0, 'в очереди есть что отправлять');

select count(*) as claimed from app.claim_notifications(50) \gset
select test.eq(:'claimed'::int, :'queued'::int, 'пачка выдана отправщику');
select test.eq((select count(*)::int from notifications where status = 'sending'),
  :'queued'::int, 'выданные помечены как взятые в работу');

-- Второй прогон отправщика их уже не увидит.
select test.eq((select count(*)::int from app.claim_notifications(50)), 0,
  'повторный прогон отправщика те же записи не возьмёт: двойной отправки нет');

-- ---- Отчёт об отправке ---------------------------------------------------
select id as nid from notifications where status = 'sending' limit 1 \gset
select app.mark_notification(:'nid', true);
select test.eq((select status from notifications where id = :'nid'),
  'sent'::notification_status, 'успешная отправка отмечена');
select test.ok((select sent_at is not null from notifications where id = :'nid'),
  'и время отправки записано');

-- ---- Неудача возвращает в очередь, но не навсегда ------------------------
select id as fid from notifications where status = 'sending' limit 1 \gset
select app.mark_notification(:'fid', false, 'сеть недоступна'::text);
select test.eq((select status from notifications where id = :'fid'),
  'pending'::notification_status, 'неудача возвращает запись в очередь');
select test.eq((select last_error from notifications where id = :'fid'),
  'сеть недоступна', 'причина записана');

-- Три попытки — и больше не берём, чтобы не долбить мёртвый канал.
select app.claim_notifications(50);
select app.mark_notification(:'fid', false, 'снова'::text);
select app.claim_notifications(50);
select app.mark_notification(:'fid', false, 'и снова'::text);
select test.eq((select status from notifications where id = :'fid'),
  'failed'::notification_status, 'после трёх попыток запись признана неудачной');
select test.eq((select count(*)::int from app.claim_notifications(50)), 0,
  'исчерпавшая попытки запись больше не выдаётся');

-- ===========================================================================
-- Агент видит свои напоминания и только свои
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(test.visible_count($$select 1 from my_reminders_v$$) > 0,
  'агент видит свои напоминания');
select test.eq(
  test.visible_count(format($$select 1 from notifications where agent_id = %L$$,
                            :'agent_bakyt')),
  0::bigint, 'чужие напоминания не видны: в них текст чужой задачи');

-- Отправщицкие функции агенту недоступны: это работа фонового задания.
select test.throws(
  $$select app.claim_notifications(10)$$,
  'permission denied',
  'агент не может забрать очередь напоминаний');
select test.throws(
  format($$select app.mark_notification(%L, true)$$, :'nid'),
  'permission denied',
  'и отметить отправку тоже');
select test.throws(
  $$insert into notifications (agent_id, activity_id, kind, body)
    values (app.current_agent_id(), '00000000-0000-0000-0000-0000000a0002', 'overdue', 'я сам')$$,
  'permission denied',
  'и дописать очередь вручную');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from my_reminders_v$$, 'permission denied',
  'напоминания анониму недоступны');
reset role;

-- ===========================================================================
-- Обёртки рассылки доступны только фоновому заданию
-- ===========================================================================
-- PostgREST отдаёт только схему public, поэтому обёртки нужны. Но EXECUTE на
-- новую функцию по умолчанию выдан PUBLIC, и без явного revoke они были бы
-- открыты всем.

select test.ok(
  not has_function_privilege('authenticated', 'public.claim_notifications(integer)', 'execute'),
  'обёртка claim_notifications агенту не выдана');
select test.ok(
  not has_function_privilege('anon', 'public.claim_notifications(integer)', 'execute'),
  'и анониму тоже');
select test.ok(
  has_function_privilege('service_role', 'public.claim_notifications(integer)', 'execute'),
  'а фоновому заданию выдана');
select test.ok(
  not has_function_privilege('authenticated', 'public.mark_notification(uuid,boolean,text)', 'execute'),
  'обёртка mark_notification агенту не выдана');
select test.ok(
  not has_function_privilege('authenticated', 'public.enqueue_due_reminders(interval)', 'execute'),
  'обёртка enqueue_due_reminders агенту не выдана');

-- Обёртки объявлены SECURITY INVOKER: DEFINER обошёл бы сам грант.
select test.eq(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('claim_notifications','mark_notification','enqueue_due_reminders')),
  0, 'обёртки рассылки НЕ security definer: иначе грант обходится');

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  $$select claim_notifications(10)$$,
  'permission denied',
  'агент не может вызвать обёртку рассылки');
reset role;

-- ===========================================================================
-- Функции public проверяют сессию сами
-- ===========================================================================
-- EXECUTE на функции схемы public по умолчанию выдан PUBLIC, то есть
-- аноним может их ВЫЗВАТЬ. Блanket revoke по схеме public опасен: туда же
-- попадают функции расширений вроде gen_random_uuid(), которые нужны
-- значениям по умолчанию. Поэтому защита — проверка сессии внутри каждой
-- функции, и вот она.

reset request.jwt.claims;
set role anon;
select test.throws(
  $$select create_object('flat', 'sale', 'Аноним', 1)$$,
  'FORBIDDEN',
  'аноним не создаёт объект, хотя функцию вызвать может');
select test.throws(
  $$select find_contact_by_phone('+996700111222')$$,
  'FORBIDDEN',
  'аноним не ищет контакты по телефону');
select test.throws(
  $$select ensure_agent()$$,
  'FORBIDDEN',
  'аноним не создаёт себе агента');
select test.throws(
  $$select update_my_profile('Аноним')$$,
  'FORBIDDEN',
  'аноним не правит профиль');
reset role;
