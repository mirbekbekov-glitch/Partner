-- ЗАЯВКИ ПОКУПАТЕЛЕЙ И АРЕНДАТОРОВ.
--
-- Проверяется ровно то, что сломалось на прежнем сайте, плюс права
-- анонима. Порядок проверок повторяет список «проверить перед сдачей»:
--   1. заявки не попадают в каталог объявлений ни в каком виде;
--   2. два агента не видят контакт одной и той же взятой заявки;
--   3. заявка без направления видна агентам обоих направлений;
--   4. повторная отправка той же формы за сутки не создаёт вторую заявку;
--   5. отметка первого ответа снимает заявку со счётчика просроченных;
--   6. телефон не показывается без согласия человека.
\i tests/actors.sql
\set ON_ERROR_STOP on

\set rq_yes   '00000000-0000-0000-0000-00000000f001'
\set rq_no    '00000000-0000-0000-0000-00000000f002'
\set rq_buy   '00000000-0000-0000-0000-00000000f003'
\set rq_rent  '00000000-0000-0000-0000-00000000f004'
\set rq_any   '00000000-0000-0000-0000-00000000f005'
\set rq_late  '00000000-0000-0000-0000-00000000f006'
\set rq_late2 '00000000-0000-0000-0000-00000000f007'
\set rq_old   '00000000-0000-0000-0000-00000000f008'

-- ===========================================================================
-- 1. Заявки отдельно от объявлений
-- ===========================================================================
-- Это главный урок прежнего сайта: 278 заявок и 2 объявления в одной
-- выгрузке. Проверяем структурно — у заявки нет и не может быть пути в
-- каталог, потому что она не объект и на objects не ссылается.

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'requests' and column_name like '%object%'),
  0, 'у заявки нет ссылки на объявление — смешать их негде');

select test.ok(
  (select count(*) from information_schema.view_column_usage
    where view_name = 'public_catalog_v' and table_name = 'requests') = 0,
  'витрина каталога не читает таблицу заявок');

-- ===========================================================================
-- Права анонима: выдана одна функция, таблица закрыта
-- ===========================================================================
reset request.jwt.claims;
set role anon;

select test.ok(
  submit_request('+996700111222', 'Азамат', 'buy', 'flat', 2, 'Асанбай',
                 60000, 'USD', 'Нужен лифт и парковка', true) is not null,
  'аноним оставляет заявку');

select test.throws($$select count(*) from requests$$,
  'permission denied for table requests',
  'аноним не читает заявки');
select test.throws(
  $$insert into requests (phone) values ('+996700000009')$$,
  'permission denied for table requests',
  'аноним не пишет в заявки мимо функции');
select test.throws($$select count(*) from request_feed_v$$,
  'permission denied for view request_feed_v',
  'ленту заявок анониму не показывают');

-- Телефон обязателен, остальное нет: чем меньше обязательных полей, тем
-- больше заявок доходит.
select test.ok(submit_request('+996555000111') is not null,
  'заявка принимается с одним телефоном');
select test.throws($$select submit_request('нет')$$, 'BAD_PHONE',
  'мусор вместо телефона не принимается');

-- 4. Склейка повторов: человек нажал три раза — заявка одна.
select test.eq(
  (select submit_request('+996700111222', 'Азамат', 'buy')),
  (select submit_request('+996700111222', 'Азамат ещё раз', 'buy')),
  'повтор того же номера за сутки возвращает прежнюю заявку');

reset role;

-- ===========================================================================
-- 2 и 6. Видимость контакта
-- ===========================================================================
\set claims_sale   '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}'

-- Заявка с согласием и заявка без него.
set role postgres;
insert into requests (id, phone, name, wishes, deal, public_consent) values
  (:'rq_yes', '+996700999001', 'Согласился', 'Хочу вид на горы', 'buy', true),
  (:'rq_no',  '+996700999002', 'Не согласился', 'Тоже хочу', 'buy', false);
reset role;

set request.jwt.claims = :'claims_aibek';
set role authenticated;

select test.ok(
  (select phone from request_feed_v where id =
     :'rq_yes') is not null,
  'свободную заявку с согласием агент видит с телефоном');

-- 6. Согласие даёт человек, а не агент.
select test.ok(
  (select phone from request_feed_v where id =
     :'rq_no') is null,
  'без согласия телефон не показывается даже на свободной заявке');

-- Айбек берёт заявку в работу.
select take_request(:'rq_yes');
select test.eq(
  (select mine_state from request_feed_v where id =
     :'rq_yes'),
  'mine', 'взятая заявка у взявшего помечена «моя»');

-- 2. Второй агент не видит контакт чужой взятой заявки.
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select mine_state from request_feed_v where id =
     :'rq_yes'),
  'other', 'у другого агента та же заявка помечена «чужая»');
select test.ok(
  (select phone from request_feed_v where id =
     :'rq_yes') is null,
  'телефон чужой взятой заявки скрыт — клиенту не позвонят пятеро');
select test.ok(
  (select name from request_feed_v where id =
     :'rq_yes') is null,
  'имя чужой взятой заявки тоже скрыто');

-- Перехватить чужую заявку нельзя.
-- Идентификатор здесь записан целиком: psql не подставляет переменные
-- внутри $$…$$, и запрос ушёл бы в базу с двоеточием.
select test.throws(
  $$select take_request('00000000-0000-0000-0000-00000000f001')$$,
  'TAKEN', 'чужую взятую заявку второй агент не перехватит');

-- ===========================================================================
-- 3. Направление работы агента
-- ===========================================================================
set role postgres;
update agents set focus = 'sale' where id = :'agent_aibek';
update agents set focus = 'rent' where id = :'agent_bakyt';
insert into requests (id, phone, deal) values
  (:'rq_buy', '+996700888001', 'buy'), (:'rq_rent', '+996700888002', 'rent'),
  (:'rq_any', '+996700888003', null);
reset role;

set request.jwt.claims = :'claims_aibek';
select test.ok(
  exists (select 1 from request_feed_v where id = :'rq_buy'),
  'продажник видит заявку на покупку');
select test.ok(
  not exists (select 1 from request_feed_v where id = :'rq_rent'),
  'продажник не видит заявку на аренду');
select test.ok(
  exists (select 1 from request_feed_v where id = :'rq_any'),
  'заявку без направления продажник видит');

set request.jwt.claims = :'claims_bakyt';
select test.ok(
  exists (select 1 from request_feed_v where id = :'rq_rent'),
  'арендник видит заявку на аренду');
select test.ok(
  exists (select 1 from request_feed_v where id = :'rq_any'),
  'заявку без направления арендник тоже видит — лучше лишний показ');

-- ===========================================================================
-- 5. Срок первого ответа
-- ===========================================================================
set role postgres;
-- Заявка, поступившая два часа назад и взятая в работу: норматив 60 минут
-- уже нарушен.
insert into requests (id, phone, deal, public_consent, status, agent_id, taken_at, created_at)
values (:'rq_late', '+996700777001', 'buy', true, 'in_work', :'agent_aibek',
        now() - interval '90 minutes', now() - interval '2 hours');
reset role;

set request.jwt.claims = :'claims_aibek';
select test.ok(
  (select overdue from request_feed_v where id =
     :'rq_late'),
  'заявка без ответа через два часа считается просроченной');

select answer_request(:'rq_late',
                      'Дозвонился, ищет двушку до 60 тысяч');
select test.ok(
  not (select overdue from request_feed_v where id =
        :'rq_late'),
  'после отметки о разговоре заявка уходит из просроченных');

-- Пустая отметка счётчик не закрывает: иначе он закрывался бы нажатием
-- кнопки, а не разговором с человеком.
set role postgres;
insert into requests (id, phone, deal, status, agent_id, taken_at, created_at)
values (:'rq_late2', '+996700777002', 'buy', 'in_work', :'agent_aibek',
        now() - interval '90 minutes', now() - interval '2 hours');
reset role;
set request.jwt.claims = :'claims_aibek';
select test.throws(
  $$select answer_request('00000000-0000-0000-0000-00000000f007', '   ')$$,
  'BAD_INPUT', 'пустой результат не считается ответом');

-- ===========================================================================
-- Закрытие и срок жизни
-- ===========================================================================
select test.throws(
  $$select close_request('00000000-0000-0000-0000-00000000f006', 'потому что')$$,
  'BAD_INPUT', 'закрыть без известной причины нельзя');

select close_request(:'rq_late', 'found_self');
select test.eq(
  (select status::text from requests where id = :'rq_late'),
  'closed', 'заявка закрывается с причиной');

-- Заявка без движения уходит в архив сама.
set role postgres;
insert into requests (id, phone, created_at)
values (:'rq_old', '+996700666001', now() - interval '45 days');
select test.ok(app.expire_requests(30) >= 1, 'старая заявка уходит в архив');
select test.eq(
  (select status::text from requests where id = :'rq_old'),
  'expired', 'архивная заявка помечена как истёкшая');
reset role;

-- ===========================================================================
-- Превращение в клиента
-- ===========================================================================
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select take_request(:'rq_buy');
select test.ok(
  convert_request(:'rq_buy') is not null,
  'заявка превращается в карточку клиента');
select test.ok(
  (select requirement_id from requests where id = :'rq_buy') is not null,
  'вместе с клиентом заводится потребность');
-- Повтор безвреден: агент нажал дважды, второго клиента не появилось.
select test.eq(
  (select count(*)::int from contacts c
     where c.id = (select contact_id from requests where id = :'rq_buy')),
  1, 'повторное превращение не плодит клиентов');
reset role;
