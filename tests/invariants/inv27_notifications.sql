-- ИНВАРИАНТ 27. Уведомление уходит один раз, тому, кому адресовано, и только
--               пока остаётся правдой.
--
--   а. Один раз: ключ в базе, а не память отправщика.
--   б. Тому, кому адресовано: в тексте адрес и имя клиента.
--   в. Гаснет вместе с поводом: показ сняли — очередь это слышит.
--   г. Кому уже сказали — тому говорят и поправку.
--   д. Очередь переживает упавшего отправщика.
--   е. Отправщику открыты три функции и ни одной таблицы.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select * from create_match(:'obj1', :'req1') \gset m1_
select * from schedule_showing(:'m1_id', test.soon()) \gset sh1_

set role postgres;
set request.jwt.claims = '{}';

-- ===========================================================================
-- 27а. Один раз
-- ===========================================================================

select test.ok(app.produce_notifications() >= 1, 'уведомления выпущены');
select test.eq(
  app.produce_notifications(), 0,
  'повторный выпуск не создаёт ничего: это ограничение базы, а не проверка');

select test.eq(
  (select count(*) from notifications
    where kind = 'showing_ahead' and showing_id = :'sh1_id'),
  1::bigint,
  'на показ ровно одно уведомление о предстоящем');

-- Дубль руками тоже не проходит: правило живёт в индексе, а не в функции.
select test.throws(
  format($$insert into notifications (kind, showing_id, agent_id, body, due_at, about_at)
           select kind, showing_id, agent_id, body, due_at, about_at
             from notifications where showing_id = %L and kind = 'showing_ahead'$$,
         :'sh1_id'),
  'notifications_once_idx',
  'дубль не вставить и напрямую');

-- ===========================================================================
-- 27б. Тому, кому адресовано
-- ===========================================================================

select test.eq(
  (select agent_id from notifications where showing_id = :'sh1_id' and kind = 'showing_ahead'),
  :'agent_bakyt'::uuid,
  'получатель — тот, кто проводит показ');

-- В тексте есть адрес и имя клиента, и телефона в нём быть не может:
-- инвариант 4 не отменяется тем, что письмо уходит участнику показа.
select test.ok(
  (select body from notifications where showing_id = :'sh1_id' and kind = 'showing_ahead')
    like '%Чүй 120%',
  'в тексте адрес: без него уведомление бесполезно');
select test.ok(
  not exists (select 1 from notifications where body ~ '[0-9]{6,}'),
  'телефона в тексте нет ни в одном уведомлении');

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  test.visible_count('select 1 from notifications'),
  0::bigint,
  'посторонний агент чужих уведомлений не видит');

select test.throws(
  format($$update notifications set body = 'подменил' where showing_id = %L$$, :'sh1_id'),
  'permission denied',
  'агент очередь не правит: её наполняет расписание');

set request.jwt.claims = :'claims_bakyt';
select test.ok(
  (select count(*) from notifications) >= 1,
  'свои уведомления агент видит');

-- ===========================================================================
-- 27в. Гаснет вместе с поводом
-- ===========================================================================

select * from schedule_showing(:'m1_id', test.soon(interval '30 minutes')) \gset sh2_
set role postgres;
set request.jwt.claims = '{}';
select test.ok(app.produce_notifications() >= 1, 'на второй показ уведомление выпущено');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select cancel_showing(:'sh2_id', 'клиент передумал') is not null as off \gset

select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh2_id' and voided_at is null and sent_at is null),
  0::bigint,
  'показ сняли — неотправленные уведомления о нём погасли');

select test.ok(
  (select void_reason from notifications where showing_id = :'sh2_id' limit 1) is not null,
  'у погашенного есть причина, а не пустое поле');

-- ===========================================================================
-- 27г. Кому сказали — тому и поправка
-- ===========================================================================
-- Самая дорогая дыра этой миграции. ОТПРАВЛЕННОЕ уведомление гасить нельзя —
-- оно ушло. Но пока ключ единственности не знал о времени показа, отправленное
-- держало место вечно: показ переносили, агенту было сказано прежнее время, и
-- поправка не приходила никогда. Система не промолчала — она соврала и
-- замолчала.

set role postgres;
set request.jwt.claims = '{}';
select id from notifications
 where showing_id = :'sh1_id' and kind = 'showing_ahead' \gset ahead_
select test.ok(app.mark_notification_sent(:'ahead_id'), 'уведомление отправлено');
select old_body from (
  select body as old_body from notifications where id = :'ahead_id') t \gset

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select reschedule_showing(:'sh1_id', test.soon(interval '1 hour')) is not null as moved \gset

select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh1_id' and kind = 'showing_changed'),
  1::bigint,
  'тому, кому уже сказали, ушла поправка');

select test.ok(
  (select body from notifications
    where showing_id = :'sh1_id' and kind = 'showing_changed') like '%перенесён%',
  'поправка говорит, что показ перенесён');

select test.eq(
  (select sent_at from notifications where id = :'ahead_id') is null, false,
  'отправленное не гасится: переписать прошлое нельзя');

-- А вот новое уведомление о НОВОМ времени выпустить теперь можно — ради
-- этого about_at и стоит в ключе.
set role postgres;
set request.jwt.claims = '{}';
select test.ok(app.produce_notifications() >= 1, 'после переноса выпущено новое уведомление');
select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh1_id' and kind = 'showing_ahead' and voided_at is null),
  2::bigint,
  'их два: одно про прежнее время (ушло), другое про новое');
select test.ok(
  (select body from notifications
    where showing_id = :'sh1_id' and kind = 'showing_ahead' and sent_at is null)
    <> :'old_body',
  'новое уведомление говорит о новом времени, а не повторяет прежнее');

-- Поправка уходит ТОЛЬКО тем, кому было что поправлять: уведомление об
-- отмене показа, о котором человек не знал, это шум, а шум учит не читать.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj2', :'req1') \gset m3_
select * from schedule_showing(:'m3_id', test.at_hour(3, 11)) \gset sh3_
set role postgres;
set request.jwt.claims = '{}';
select app.produce_notifications() as made \gset
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select cancel_showing(:'sh3_id', 'сорвалось') is not null as off3 \gset
select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh3_id' and kind = 'showing_changed'),
  0::bigint,
  'о показе, про который не сообщали, поправки нет');

-- Показ подвигали туда-обратно, ничего не отправив. Погашенное уведомление
-- о прежнем времени не должно мешать выпустить его заново, когда время
-- вернулось: ради этого ключ единственности частичный. Случай не выдуманный —
-- агент правит время между двумя запусками расписания, и отправлено за это
-- время ничего не было.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from schedule_showing(:'m1_id', test.soon(interval '2 hours')) \gset sh4_
set role postgres;
set request.jwt.claims = '{}';
select app.produce_notifications() as made4 \gset
select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh4_id' and kind = 'showing_ahead' and voided_at is null),
  1::bigint,
  'уведомление о показе выпущено');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select reschedule_showing(:'sh4_id', test.soon(interval '1 hour')) is not null as away \gset
select reschedule_showing(:'sh4_id', test.soon(interval '2 hours')) is not null as back4 \gset
select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh4_id' and kind = 'showing_ahead' and voided_at is null),
  0::bigint,
  'оба прежних уведомления погасли: время менялось дважды');

set role postgres;
set request.jwt.claims = '{}';
select test.ok(app.produce_notifications() >= 1, 'на вернувшееся время уведомление выпускается заново');
select test.eq(
  (select count(*) from notifications
    where showing_id = :'sh4_id' and kind = 'showing_ahead' and voided_at is null),
  1::bigint,
  'погашенное уведомление место в ключе не занимает');

-- ===========================================================================
-- 27д. Очередь переживает упавшего отправщика
-- ===========================================================================

set role notifier;

select count(*) as taken from app.take_notifications(50) \gset first_
select test.ok(:'first_taken'::int >= 1, 'отправщик взял пачку');

select test.eq(
  (select count(*) from app.take_notifications(50)),
  0::bigint,
  'второй заход не выдаёт то же самое: взятое занято');

set role postgres;
set request.jwt.claims = '{}';
select id from notifications
 where sent_at is null and voided_at is null and claimed_at is not null limit 1 \gset one_

select test.ok(
  app.mark_notification_failed(:'one_id', 'телеграм не ответил'),
  'неудача записывается, а не выбрасывается исключением');
select test.eq(
  (select last_error from notifications where id = :'one_id'),
  'телеграм не ответил',
  'причина неудачи сохранена — именно она переживает откат');

set role notifier;
select test.ok(
  exists (select 1 from app.take_notifications(50) t where t.id = :'one_id'),
  'неудачное вернулось в очередь');

-- Отправщик умер, не отметив ничего. Взятие отпускается по сроку.
set role postgres;
set request.jwt.claims = '{}';
update notifications set claimed_at = now() - app.notify_claim_ttl() - interval '1 minute'
 where sent_at is null and voided_at is null;
select test.ok(
  app.release_stale_notifications() >= 1,
  'зависшие взятия возвращаются в очередь: отправщик мог умереть на середине');

select test.ok(
  (select attempts from notifications where id = :'one_id') >= 2,
  'счётчик попыток растёт при взятии: процесс, умерший на середине, иначе не оставил бы следа');

-- Погашенное не отправляется и не отмечается.
select id from notifications where voided_at is not null limit 1 \gset dead_
select test.eq(app.mark_notification_sent(:'dead_id'), false,
  'погашенное отправленным не отметить');

-- ===========================================================================
-- 27е. Отправщику открыты три функции и ни одной таблицы
-- ===========================================================================
-- Процесс, умеющий только отправлять, при утечке токена и может только
-- отправлять: ни клиентов, ни сделок, ни самой очереди он не прочитает.

select test.ok(
  not has_table_privilege('notifier', 'notifications', 'select'),
  'отправщик не читает очередь целиком');
select test.ok(
  not has_table_privilege('notifier', 'contacts', 'select'),
  'отправщик не читает контакты');
select test.ok(
  not has_table_privilege('notifier', 'showings', 'select'),
  'отправщик не читает показы');
select test.ok(
  not has_function_privilege('notifier', 'app.produce_notifications()', 'execute'),
  'отправщик не выпускает уведомления: он только отправляет');
select test.ok(
  has_function_privilege('notifier', 'app.take_notifications(integer)', 'execute')
  and has_function_privilege('notifier', 'app.mark_notification_sent(uuid)', 'execute')
  and has_function_privilege('notifier', 'app.mark_notification_failed(uuid, text)', 'execute'),
  'ему открыты ровно взять и отметить');

-- Та же проверка со стороны инварианта 15: наружу ничего не открыто PUBLIC.
select test.eq(
  (select count(*) from app.functions_open_to_public() f
    where f.function_name like '%notif%' or f.function_name = 'day_word'),
  0::bigint,
  'ни одна функция уведомлений не открыта PUBLIC');

-- ===========================================================================
-- Работа в расписании
-- ===========================================================================
-- Без расписания уведомления не выпускаются вовсе, и это та самая тишина, от
-- которой защищает инвариант 16.

select test.eq(
  (select handler::text from maintenance_jobs where job = 'produce_notifications'),
  'app.job_produce_notifications()',
  'выпуск уведомлений стоит в расписании');
select test.ok(
  (select enabled from maintenance_jobs where job = 'produce_notifications'),
  'и включён');

-- ===========================================================================
-- 27ж. Объект, который давно не подтверждали (миграция 0055)
-- ===========================================================================
-- Владелец продукта решил предупреждать, а не снимать. Значит уведомление и
-- есть весь механизм, и держаться оно должно на тех же трёх правилах, что
-- остальные: один раз, тому, кому адресовано, и только пока правда.
--
-- Автоснятие при ПРОСРОЧЕННОМ ДОГОВОРЕ — другой механизм, он проверяется
-- инвариантом 1: там договора нет, и показывать объявление не на чем.

set role postgres;
set request.jwt.claims = '{}';

-- Давность задаётся ПРИ ВСТАВКЕ: назад actual_at не двигается ничем, так
-- устроен инвариант 5.
-- Завёл объект ОДИН агент, а договор ведёт ДРУГОЙ. Так бывает после
-- передачи объекта и когда карточку заводит помощник. Разведены они нарочно:
-- пока оба были Айбеком, проверка адресата не умела упасть — мутация
-- «слать создателю вместо листинг-агента» её пережила.
\set obj_quiet '00000000-0000-0000-0000-0000000fd001'
insert into objects (id, kind, deal_type, address, zone, price, actual_at,
                     created_by_agent_id)
values (:'obj_quiet', 'flat', 'sale', 'Молчит сорок дней', 'Центр', 70000,
        now() - interval '40 days', :'agent_bakyt');

insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_quiet', :'contact_owner', 'owner', 1.0);

insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_quiet', 'exclusive', current_date - 60, 70000,
        :'agent_aibek', true, 'active');

update objects set publication_state = 'published' where id = :'obj_quiet';

create or replace function pg_temp.quiet_notices() returns integer
  language sql stable as $$
  select count(*)::integer from notifications
   where object_id = '00000000-0000-0000-0000-0000000fd001'
     and kind = 'object_stale' and voided_at is null
$$;

select test.eq(pg_temp.quiet_notices(), 0,
  'уведомления об объекте пока нет: проверки ниже не вакуумны');

select app.produce_notifications();

select test.eq(pg_temp.quiet_notices(), 1,
  'выпущено одно уведомление о давно не подтверждённом объекте');

select test.eq(
  (select agent_id from notifications
    where object_id = :'obj_quiet' and kind = 'object_stale' and voided_at is null),
  :'agent_aibek',
  'адресовано listing-агенту договора, а не заводившему объект');

select test.ok(
  (select body from notifications
    where object_id = :'obj_quiet' and kind = 'object_stale' and voided_at is null)
    like '%Молчит сорок дней%',
  'в тексте назван объект, а не только число дней');

-- Один раз за одно протухание, а не каждую ночь. Расписание зовёт выпуск
-- ежечасно; без этого агент получал бы одно и то же письмо до отпуска.
select app.produce_notifications();
select app.produce_notifications();
select test.eq(pg_temp.quiet_notices(), 1,
  'повторные прогоны выпуска второго уведомления не делают');

-- Подтвердил — неотправленное гаснет. Письмо «не подтверждали 40 дней»,
-- пришедшее через час после подтверждения, учит не верить уведомлениям.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select app.confirm_actual(:'obj_quiet');

set role postgres;
set request.jwt.claims = '{}';
select test.eq(pg_temp.quiet_notices(), 0,
  'после подтверждения неотправленное уведомление погашено');

select test.ok(
  (select void_reason from notifications
    where object_id = :'obj_quiet' and kind = 'object_stale') like '%подтверждён%',
  'и сказано, почему оно погашено');

-- И свежий объект нового повода не даёт.
select app.produce_notifications();
select test.eq(pg_temp.quiet_notices(), 0,
  'у свежеподтверждённого объекта повода нет');

-- А снятый с каталога не беспокоит вовсе, даже если молчит давно: он уже не
-- обманывает никого.
\set obj_gone '00000000-0000-0000-0000-0000000fd002'
insert into objects (id, kind, deal_type, address, zone, price, actual_at,
                     created_by_agent_id)
values (:'obj_gone', 'flat', 'sale', 'Снят и молчит', 'Центр', 70000,
        now() - interval '40 days', :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_gone', :'contact_owner', 'owner', 1.0);
insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_gone', 'exclusive', current_date - 60, 70000,
        :'agent_aibek', true, 'active');

select app.produce_notifications();
select test.eq(
  (select count(*)::int from notifications
    where object_id = :'obj_gone' and kind = 'object_stale' and voided_at is null),
  0,
  'объект вне каталога уведомления не порождает');

-- Уведомление обязано ДОЙТИ ДО ЭКРАНА агента, и с адресом.
--
-- Представление выводило объект только через показ: уведомление → показ →
-- подбор → объект. У уведомления об объекте показа нет, и на экране оно
-- было бы строкой без адреса — «что-то случилось, догадайтесь где».
-- Читается ПОД АГЕНТОМ, а не под postgres: иначе проверка обходила бы тот
-- самый путь, которым ходит кабинет.
\set obj_quiet2 '00000000-0000-0000-0000-0000000fd003'
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, zone, price, actual_at,
                     created_by_agent_id)
values (:'obj_quiet2', 'flat', 'sale', 'Виден на экране 7', 'Центр', 70000,
        now() - interval '40 days', :'agent_bakyt');
insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_quiet2', :'contact_owner', 'owner', 1.0);
insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_quiet2', 'exclusive', current_date - 60, 70000,
        :'agent_aibek', true, 'active');
update objects set publication_state = 'published' where id = :'obj_quiet2';
select app.produce_notifications();

set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.eq(
  (select count(*)::int from my_notifications_v
    where object_id = :'obj_quiet2' and kind = 'object_stale'),
  1,
  'уведомление об объекте видно агенту на экране');

select test.eq(
  (select address from my_notifications_v
    where object_id = :'obj_quiet2' and kind = 'object_stale'),
  'Виден на экране 7',
  'и адрес объекта на экране назван');

-- Чужому агенту его не видно: политика таблицы, а не отбор в запросе.
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select count(*)::int from my_notifications_v
    where object_id = :'obj_quiet2' and kind = 'object_stale'),
  0,
  'чужому агенту это уведомление не видно');
