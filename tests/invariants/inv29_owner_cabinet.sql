-- ИНВАРИАНТ 29. У собственника есть кабинет, и в нём он распоряжается
--               доступом в свою квартиру.
--
--   а. Кабинет выдаётся контакту, а не объекту: все его объекты сразу.
--   б. Кабинет показывает то же, что отчёт, плюс КОГДА придут. Имён клиентов
--      и комиссии в нём нет — инвариант 4 действует и в эту сторону.
--   в. Приостановка показов — состояние объекта: новых показов нет,
--      назначенные сняты.
--   г. Снять паузу собственника может он сам или администратор. Агент — нет.
--   д. Чужим объектом по своей ссылке не распорядиться.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- 29а. Кабинет выдаётся собственнику, а не объекту
-- ===========================================================================
-- У Орозова три объекта и до сих пор было три ссылки: он не знал, какая от
-- какой.

set request.jwt.claims = :'claims_aibek';
set role authenticated;

select * from issue_owner_cabinet(:'contact_owner') \gset cab_
select test.ok(:'cab_id' is not null, 'кабинет выдан');
-- NULL в \gset не пустая строка, а ОТСУТСТВИЕ переменной, поэтому читаем
-- из таблицы: :'cab_object_id' был бы синтаксической ошибкой.
select test.ok(
  (select object_id from owner_access where id = :'cab_id') is null,
  'кабинет не привязан к объекту');

-- Повторная выдача продлевает, а не плодит вторую ссылку: иначе отозвать
-- доступ значило бы вспомнить все отправленные.
select * from issue_owner_cabinet(:'contact_owner') \gset cab2_
select test.eq(:'cab2_id'::text, :'cab_id'::text,
  'повторная выдача вернула ту же ссылку');
select test.eq(
  (select count(*) from owner_access
    where contact_id = :'contact_owner' and object_id is null and revoked_at is null),
  1::bigint,
  'действующий кабинет у собственника один');

-- «Одна ссылка» держится ограничением в базе, а не вежливостью функции:
-- мимо issue_owner_cabinet() второй кабинет тоже не завести.
set role postgres;
set request.jwt.claims = '{}';
select test.throws(
  format($$insert into owner_access (object_id, contact_id, token, issued_by_agent_id)
           values (null, %L, 'ffffffffffffffffffffffffffffffff', %L)$$,
         :'contact_owner', :'agent_aibek'),
  'owner_access_cabinet_idx',
  'второй действующий кабинет тому же собственнику не завести и напрямую');
set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- Кабинет не выдать тому, кто ничего не сдаёт через нас.
select test.throws(
  format($$select issue_owner_cabinet(%L)$$, :'contact_client'),
  'INVARIANT_29',
  'клиенту кабинет собственника не выдаётся: он ничем не владеет');

-- ---------------------------------------------------------------------------
-- Соседи по базе
-- ---------------------------------------------------------------------------
-- В сценарии приёмки собственник ровно один, и кабинет, показывающий ВСЕ
-- объекты базы, прошёл бы проверку «в кабинете три объекта» не заметив
-- ничего. Поэтому рядом заводятся два объекта, которых в кабинете быть не
-- должно: чужой и свой, но без действующего договора.
set role postgres;
set request.jwt.claims = '{}';

insert into contacts (id, kind, name, owner_agent_id, roles, source) values
  ('00000000-0000-0000-0000-00000000c0f1', 'person', 'Соседов Собственник',
   :'agent_aibek', '{owner}', 'рекомендация');

insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f8001', 'flat', 'sale', 'Соседняя 7', 70000,
        :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share)
values ('00000000-0000-0000-0000-0000000f8001',
        '00000000-0000-0000-0000-00000000c0f1', 'owner', 1);
insert into mandates (object_id, kind, valid_from, start_price, listing_agent_id,
                      contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000f8001', 'exclusive', current_date - 30,
        70000, :'agent_aibek', true, 'active');

-- Свой, но договор по нему закончился: отчитываться не о чем.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f8002', 'flat', 'sale', 'Без договора 3', 60000,
        :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share)
values ('00000000-0000-0000-0000-0000000f8002', :'contact_owner', 'owner', 1);

-- ===========================================================================
-- 29б. Что собственник видит
-- ===========================================================================

set role anon;
set request.jwt.claims = '{"role":"anon"}';

select app.owner_cabinet(:'cab_token') as cab \gset
select test.ok(:'cab' is not null, 'кабинет открывается по ссылке');

select test.eq(
  jsonb_array_length((:'cab'::jsonb) -> 'objects'), 3,
  'в кабинете все три объекта собственника');

select test.ok(
  (:'cab'::jsonb) -> 'owner' ->> 'name' = 'Орозов Собственник',
  'и его имя');

-- Ровно три — потому что соседних объектов в кабинете нет. Без этих двух
-- проверок «три» означало бы только «в базе три объекта».
select test.ok(
  (:'cab'::jsonb)::text not like '%Соседняя 7%',
  'чужой объект в кабинет не попал');
select test.ok(
  (:'cab'::jsonb)::text not like '%Без договора 3%',
  'свой объект без действующего договора в кабинет не попал');

-- Те же запреты, что в отчёте: ни комиссии, ни имён клиентов, ни их слов.
select test.ok(
  (:'cab'::jsonb)::text not like '%Жумаев%',
  'имени клиента в кабинете нет');
select test.ok(
  (:'cab'::jsonb)::text not like '%commission%'
  and (:'cab'::jsonb)::text not like '%agent%',
  'комиссии и агентов в кабинете нет');

-- Ссылка на один объект кабинетом не открывается: один токен — одна дверь.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select * from issue_owner_access(:'obj1', :'contact_owner') \gset one_
set role anon;
select test.ok(
  app.owner_cabinet(:'one_token') is null,
  'ссылка на один объект кабинет не открывает');
select test.ok(
  app.owner_report(:'one_token') is not null,
  'и продолжает работать как отчёт: инвариант 10 не отменён');

select test.ok(
  app.owner_cabinet('00000000000000000000000000000000') is null,
  'чужой токен не открывает ничего');

-- ===========================================================================
-- 29в. Приостановка — состояние объекта
-- ===========================================================================
-- Пока пауза стоит: нового показа не назначить ничем, назначенные сняты.
-- Это и отличает право от просьбы.

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj1', :'req1') \gset m1_
select * from schedule_showing(:'m1_id', test.at_hour(2)) \gset sh1_
select test.eq(:'sh1_status'::text, 'scheduled', 'показ назначен');

set role anon;
select app.owner_pause(:'cab_token', :'obj1', true, 'уезжаю до декабря') as p1 \gset
select test.ok(((:'p1'::jsonb) ->> 'ok')::boolean, 'собственник приостановил показы');

-- Читает показы агент, а не аноним: у анонима прав на эту таблицу нет и не
-- должно быть. Собственник видит показы только через app.owner_cabinet().
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select status from showings where id = :'sh1_id'),
  'cancelled'::showing_status,
  'назначенный показ снят приостановкой');
select test.ok(
  (select cancel_reason from showings where id = :'sh1_id') like '%приостановлены%',
  'и причина названа словами, а не кодом');

select test.throws(
  format($$select schedule_showing(%L, test.at_hour(3))$$, :'m1_id'),
  'INVARIANT_29',
  'на приостановленный объект показ не назначить');

-- Правило держится и мимо функции: оно в триггере, а не в слое доступа.
select test.throws(
  format($$insert into showings (match_id, agent_id, scheduled_at, created_by_agent_id)
           values (%L, %L, test.at_hour(4), %L)$$,
         :'m1_id', :'agent_bakyt', :'agent_bakyt'),
  'INVARIANT_29',
  'и прямой вставкой тоже');

-- Правило смотрит и на правку: иначе снятый паузой показ возвращался бы
-- обратно одним update, и приостановка держалась бы ровно до первой попытки.
select test.throws(
  format($$update showings set status = 'scheduled' where id = %L$$, :'sh1_id'),
  'INVARIANT_29',
  'снятый приостановкой показ не вернуть, пока пауза стоит');

-- Приостановка выведена из-под инварианта 22 ПО СТОЛБЦАМ, а не по названию
-- действия: правка цены, приехавшая вместе с паузой, остаётся правкой.
select test.throws(
  format($$update objects
              set showings_paused_at = now(), showings_paused_by = 'owner',
                  price = price + 1000
            where id = %L$$, :'obj2'),
  'INVARIANT_22',
  'под видом приостановки цену чужого объекта не поправить');

-- Причина обязательна: агенту надо знать, что отвечать клиентам.
set role anon;
select app.owner_pause(:'cab_token', :'obj2', true, '  ') as p2 \gset
select test.ok(
  not ((:'p2'::jsonb) ->> 'ok')::boolean,
  'приостановка без причины отклонена');
select test.ok(
  ((:'p2'::jsonb) ->> 'reason') like '%причину%',
  'и собственнику объяснено, чего не хватает');

-- Отказ приходит ОТВЕТОМ, а не страницей ошибки: собственнику пятисотая
-- страница не объясняет ничего.
select test.ok(
  ((:'p2'::jsonb) ? 'ok') and ((:'p2'::jsonb) ? 'reason'),
  'отказ — это ответ с причиной, а не исключение');

-- ===========================================================================
-- 29г. Снять паузу собственника агент не может
-- ===========================================================================
-- Иначе право превращается в пожелание, которое отменяют, не спросив.

set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format($$select resume_showings(%L)$$, :'obj1'),
  'INVARIANT_29',
  'агент паузу собственника не снимает');

select test.ok(
  (select showings_paused_at from objects where id = :'obj1') is not null,
  'и после отказа пауза на месте');

-- Собственник снимает сам.
set role anon;
select app.owner_pause(:'cab_token', :'obj1', false) as p3 \gset
select test.ok(((:'p3'::jsonb) ->> 'ok')::boolean, 'собственник снял паузу сам');
select test.ok(
  (select showings_paused_at from objects where id = :'obj1') is null,
  'показы возобновлены');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select status from schedule_showing(:'m1_id', test.at_hour(5))),
  'scheduled'::showing_status,
  'после снятия показ назначается');

-- Причина обязательна не только собственнику. Правило живёт в app.set_pause(),
-- и путь агента проходит через него же: иначе «приостановлено без
-- объяснения» приходило бы клиенту от агентства.
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format($$select pause_showings(%L, '   ')$$, :'obj1'),
  'INVARIANT_29',
  'агент без причины показы тоже не приостанавливает');

-- Паузу агента агент снимает: правило про авторство, а не про должность.
select pause_showings(:'obj1', 'собственник просил по телефону') is not null as ap \gset
select test.eq(
  (select showings_paused_by from objects where id = :'obj1'),
  'agent'::pause_author,
  'агент тоже может приостановить, и это видно по автору');
select test.ok(
  (select showings_paused_at from resume_showings(:'obj1')) is null,
  'свою паузу агент снимает');

-- Администратор снимает любую: он разбирает случаи, когда собственник
-- позвонил, а ссылку потерял.
set role anon;
select app.owner_pause(:'cab_token', :'obj1', true, 'ещё раз уезжаю') is not null as p4 \gset
set role authenticated;
set request.jwt.claims = :'claims_admin';
select test.ok(
  (select showings_paused_at from resume_showings(:'obj1')) is null,
  'администратор снимает и паузу собственника');

-- ---------------------------------------------------------------------------
-- «Когда придут» — это будущее
-- ---------------------------------------------------------------------------
-- Прошедший показ, оставшийся в состоянии «назначен», для собственника
-- выглядит как завтрашний гость. Он не гость, он забытая запись.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
insert into showings (match_id, agent_id, scheduled_at, created_by_agent_id)
values (:'m1_id', :'agent_bakyt', test.at_hour(-1, 11), :'agent_bakyt');

set role anon;
select test.eq(
  (select count(*)
     from jsonb_array_elements(app.owner_cabinet(:'cab_token') -> 'objects') o,
          jsonb_array_elements_text(o -> 'showings_ahead') t
    where t::timestamptz < now()),
  0::bigint,
  'среди «когда придут» нет прошедших показов');

-- ===========================================================================
-- 29д. Чужим объектом по своей ссылке не распорядиться
-- ===========================================================================

set role anon;
select app.owner_pause(:'cab_token', :'obj3', true, 'проверка') as own3 \gset
select test.ok(((:'own3'::jsonb) ->> 'ok')::boolean,
  'своим третьим объектом собственник распоряжается');

-- Объект, которым контакт не владеет. В сценарии приёмки все три объекта
-- принадлежат одному собственнику, поэтому заводим чужой.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f9001', 'flat', 'sale', 'Чужая 1', 50000,
        :'agent_aibek');
set role anon;
select app.owner_pause(:'cab_token', '00000000-0000-0000-0000-0000000f9001', true, 'чужое')
  as alien \gset
select test.ok(
  not ((:'alien'::jsonb) ->> 'ok')::boolean,
  'чужим объектом по своей ссылке не распорядиться');
select test.eq(
  (:'alien'::jsonb) ->> 'reason', 'это не ваш объект',
  'и сказано об этом прямо');

-- Ссылка на ОДИН объект распоряжается только им, хотя контакт тот же.
select app.owner_pause(:'one_token', :'obj2', true, 'через узкую ссылку') as narrow \gset
select test.ok(
  not ((:'narrow'::jsonb) ->> 'ok')::boolean,
  'узкая ссылка не распоряжается другими объектами того же собственника');

select app.owner_pause(:'one_token', :'obj1', true, 'свой объект узкой ссылкой') as narrow2 \gset
select test.ok(
  ((:'narrow2'::jsonb) ->> 'ok')::boolean,
  'а своим объектом — распоряжается');

-- Отозванная ссылка не распоряжается ничем.
set role postgres;
set request.jwt.claims = '{}';
update owner_access set revoked_at = now() where token = :'cab_token';
set role anon;
select app.owner_pause(:'cab_token', :'obj3', false) as dead \gset
select test.ok(
  not ((:'dead'::jsonb) ->> 'ok')::boolean,
  'отозванная ссылка не распоряжается ничем');
select test.ok(
  app.owner_cabinet(:'cab_token') is null,
  'и кабинета не открывает');
