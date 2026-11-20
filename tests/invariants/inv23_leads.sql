-- ЗАЯВКА С САЙТА. Первая запись в базу от неизвестного.
--
-- Проверяется не форма, а то, что остаётся, когда форму обходят и бьют
-- прямо в PostgREST: права анонима, границы ввода, частота, видимость
-- телефона заявителя и попадание заявки в работу агента.
\i tests/actors.sql
\set ON_ERROR_STOP on

\set obj_pub   '00000000-0000-0000-0000-0000000b0001'
\set obj_draft '00000000-0000-0000-0000-0000000b23ff'

-- Все объекты сценария приёмки опубликованы, поэтому черновик для проверки
-- отказа заводим здесь же.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values (:'obj_draft', 'flat', 'sale', 'Черновик для заявок', 60000,
        '00000000-0000-0000-0000-0000000000a1');

select test.eq((select publication_state::text from objects where id = :'obj_pub'),
  'published', 'объект для заявок опубликован');
select test.eq((select publication_state::text from objects where id = :'obj_draft'),
  'draft', 'черновик для проверки отказа заведён');

-- ===========================================================================
-- Что анониму выдано, а что нет
-- ===========================================================================
reset request.jwt.claims;
set role anon;

select test.ok(
  (select submit_lead(:'obj_pub', 'Азамат', '+996700123456', 'Можно посмотреть в субботу?')) is not null,
  'аноним оставляет заявку на опубликованный объект');

-- Таблица заявок анониму не выдана вовсе: ни читать, ни писать.
select test.throws(
  $$select count(*) from leads$$,
  'permission denied for table leads',
  'аноним не читает заявки — даже свои');
select test.throws(
  $$insert into leads (object_id, name, phone)
    values ('00000000-0000-0000-0000-0000000b0001', 'Мимо формы', '+996700000001')$$,
  'permission denied for table leads',
  'аноним не пишет в заявки напрямую, мимо функции');
-- id подставляем literal-ом: подзапрос к leads упал бы раньше, на чтении
-- таблицы, и проверка говорила бы не о том, о чём заявлено.
reset role;
select id as lead_id from leads order by created_at limit 1 \gset
set role anon;
select test.throws(
  format($$select set_lead_status(%L, 'done')$$, :'lead_id'),
  'permission denied for function set_lead_status',
  'аноним не трогает статус заявки');

-- Два слоя, а не один: даже если грант на таблицу однажды выдадут по
-- ошибке, политика адресована authenticated, и анониму строк не достанется.
reset role;
select test.ok(
  (select array['authenticated']::name[] = polroles::regrole[]::name[]
     from pg_policy where polname = 'leads_read'),
  'политика чтения заявок адресована только authenticated');
set role anon;

-- ===========================================================================
-- Границы ввода. Проверка живёт в базе, а не в форме.
-- ===========================================================================
select test.throws(
  format($$select submit_lead(%L, 'Азамат', '+996700123456')$$, :'obj_draft'),
  'NOT_FOUND',
  'на неопубликованный объект заявку не оставить');
-- Ответ одинаков и для несуществующего объекта: существование черновика
-- не должно выясняться перебором.
select test.throws(
  $$select submit_lead('00000000-0000-0000-0000-00000000dead', 'Азамат', '+996700123456')$$,
  'NOT_FOUND',
  'на несуществующий объект — тот же ответ, без намёка');

select test.throws(
  format($$select submit_lead(%L, '   ', '+996700123456')$$, :'obj_pub'),
  'BAD_INPUT',
  'пустое имя отклонено');
select test.throws(
  format($$select submit_lead(%L, %L, '+996700123456')$$, :'obj_pub', repeat('я', 121)),
  'BAD_INPUT',
  'имя длиннее 120 символов отклонено');
select test.throws(
  format($$select submit_lead(%L, 'Азамат', '+996700123456', %L)$$, :'obj_pub', repeat('a', 2001)),
  'BAD_INPUT',
  'сообщение длиннее 2000 символов отклонено');
select test.throws(
  format($$select submit_lead(%L, 'Азамат', 'не телефон')$$, :'obj_pub'),
  'BAD_PHONE',
  'телефон, не похожий на номер, отклонён');

-- ===========================================================================
-- Повтор и частота
-- ===========================================================================
-- Человек нажал дважды — агент не должен получить две заявки и два звонка.
select test.eq(
  (select submit_lead(:'obj_pub', 'Азамат', '0700 12 34 56'))::text,
  (select submit_lead(:'obj_pub', 'Азамат', '+996700123456'))::text,
  'повтор того же номера по тому же объекту возвращает ТУ ЖЕ заявку');
-- И записью в базе это подтверждается: заявка одна, а не две.
reset role;
select test.eq((select count(*)::int from leads where phone_normalized = '700123456'), 1,
  'в базе одна заявка, а не две — формат номера ограничение не обходит');
set role anon;

-- Частота: пять заявок с одного номера в час — потолок.
select submit_lead(:'obj_pub', 'Перебор', '+996700999001');
select submit_lead('00000000-0000-0000-0000-0000000b0002', 'Перебор', '+996700999001');
reset role;
-- Остальные три «заявки» того же номера досыпаем владельцем таблиц: цель —
-- проверить СЧЁТЧИК, а не изобретать третий объект.
insert into leads (object_id, name, phone) values
  ('00000000-0000-0000-0000-0000000b0001', 'Перебор', '+996700999001'),
  ('00000000-0000-0000-0000-0000000b0001', 'Перебор', '+996700999001'),
  ('00000000-0000-0000-0000-0000000b0001', 'Перебор', '+996700999001');
set role anon;
-- Шестая — на ТРЕТИЙ объект: по паре «номер + объект», где заявка уже была,
-- сработала бы склейка повторов, и проверялся бы не счётчик, а она.
select test.throws(
  $$select submit_lead('00000000-0000-0000-0000-0000000b0003', 'Перебор', '0700 999 001')$$,
  'TOO_MANY',
  'шестая заявка с одного номера за час отклонена');
reset role;

-- ===========================================================================
-- ИНВАРИАНТ 4 для заявителя: телефон виден тому, кто ведёт объект
-- ===========================================================================
-- obj1 ведёт Айбек (мандат из сценария приёмки). Чынгыз к объекту отношения
-- не имеет.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(test.visible_count(format($$select 1 from leads where object_id = %L$$, :'obj_pub')),
  (select count(*) from leads where object_id = :'obj_pub'),
  'агент объекта видит заявки по своему объекту');
reset role;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(test.visible_count($$select 1 from leads$$), 0::bigint,
  'посторонний агент не видит ни одной заявки, включая телефон заявителя');
-- id берём известный, а не подзапросом: RLS прячет заявку от постороннего,
-- подзапрос вернул бы NULL, и функция ответила бы «не найдена» — проверка
-- прошла бы, ничего не проверив. Смысл в том, что и ЗНАЯ id, посторонний
-- заявку не тронет.
select test.throws(
  format($$select set_lead_status(%L, 'done')$$, :'lead_id'),
  'FORBIDDEN',
  'посторонний агент не трогает чужую заявку, даже зная её id');
reset role;

-- Админ видит всё: иначе некому разбирать спам.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(test.visible_count($$select 1 from leads$$) > 0,
  'админ видит заявки');
reset role;

-- ===========================================================================
-- Заявка попадает в работу
-- ===========================================================================
-- Заявка, о которой никому не сказали, бесполезна: по ней заводится задача
-- агенту, который ведёт объект, — и она подхватывает напоминания (0024).
select test.ok(
  (select activity_id is not null from leads
    where object_id = :'obj_pub' and phone_normalized = '700123456'),
  'по заявке заведена задача');
select test.eq(
  (select a.agent_id from leads l join activities a on a.id = l.activity_id
    where l.phone_normalized = '700123456')::text,
  (select m.listing_agent_id from mandates m
    where m.object_id = :'obj_pub' and m.status = 'active')::text,
  'задача досталась listing-агенту объекта');
select test.ok(
  (select not a.is_shared from leads l join activities a on a.id = l.activity_id
    where l.phone_normalized = '700123456'),
  'задача не общая: в ней имя заявителя, и видеть её должен ведущий объект');
-- Телефона в тексте задачи нет: он живёт в заявке, под своим правилом.
select test.ok(
  (select a.body not like '%996700123456%' and a.body not like '%700123456%'
     from leads l join activities a on a.id = l.activity_id
    where l.phone_normalized = '700123456'),
  'телефон заявителя не продублирован в текст задачи');

-- ===========================================================================
-- Работа с заявкой
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select * from set_lead_status(
  (select id from leads where phone_normalized = '700123456'), 'in_work') \gset lw_
select test.eq(:'lw_status'::text, 'in_work', 'агент взял заявку в работу');
select test.eq(:'lw_agent_id'::text, '00000000-0000-0000-0000-0000000000a1',
  'заявка закрепилась за тем, кто её взял');

-- Прямая правка мимо функции закрыта и агенту объекта.
select test.throws(
  $$update leads set status = 'done'$$,
  'permission denied for table leads',
  'даже свой агент не правит заявку напрямую, мимо функции');
reset role;

-- ===========================================================================
-- Инвариант 7: заявка в журнале
-- ===========================================================================
select test.ok(
  exists (select 1 from audit_log where entity_type = 'lead' and action = 'insert'),
  'появление заявки записано в журнал');
select test.ok(
  exists (select 1 from audit_log where entity_type = 'lead' and action = 'update'),
  'смена статуса заявки записана в журнал');
