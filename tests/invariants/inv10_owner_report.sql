-- ИНВАРИАНТ 10. Отчёт собственнику открывается только по действующему токену,
--               выданному владельцем мандата собственнику этого объекта.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- ---- 10а. Ссылку выдаёт listing-агент собственнику своего объекта --------
select * from issue_owner_access(:'obj1', :'contact_owner', 30) \gset t1_
select test.ok(:'t1_token' is not null, 'ссылка выдана');
select test.ok(length(:'t1_token') = 32, 'токен это 32 знака случайности');
select test.eq(:'t1_issued_by_agent_id'::text, :'agent_aibek'::text,
  'выдал listing-агент мандата');

-- ---- 10б. Повторная выдача не плодит вторую ссылку ------------------------
-- Иначе отозвать доступ значило бы вспомнить все отправленные ссылки.
select * from issue_owner_access(:'obj1', :'contact_owner', 90) \gset t2_
select test.eq(:'t2_token'::text, :'t1_token'::text,
  'повторная выдача вернула ту же ссылку');
select test.eq(
  (select count(*)::int from owner_access
    where object_id = :'obj1' and contact_id = :'contact_owner'),
  1, 'вторая строка доступа не создана');

-- ---- 10в. Не собственнику ссылку не выдать -------------------------------
-- contact_client это покупатель, он не числится собственником obj1.
select test.throws(
  format($$select issue_owner_access(%L, %L)$$, :'obj1', :'contact_client'),
  'INVARIANT_10',
  'чужому контакту ссылку на отчёт не выдать');

-- ---- 10г. Выдаёт только владелец мандата ---------------------------------
-- Мандат на obj1 у Айбека. Бакыт агент, но к этому объекту отношения не имеет.
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select issue_owner_access(%L, %L)$$, :'obj2', :'contact_owner'),
  'INVARIANT_10',
  'не владелец мандата ссылку выдать не может');

-- ---- 10д. Без мандата отчитываться не о чем ------------------------------
set role postgres;
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fb001', 'flat', 'sale', 'Без мандата', 50000,
        :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share)
values ('00000000-0000-0000-0000-0000000fb001', :'contact_owner', 'owner', 1);
set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.throws(
  format($$select issue_owner_access(%L, %L)$$,
         '00000000-0000-0000-0000-0000000fb001', :'contact_owner'),
  'INVARIANT_10',
  'без активного мандата ссылку не выдать');

-- ---- 10е. Отчёт открывается анониму по токену ----------------------------
-- Готовим работу по объекту: показ с реакцией и выгрузку в канал.
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj1', :'req1') \gset m1_
select * from schedule_showing(:'m1_id', now() + interval '1 day') \gset sh1_
select * from complete_showing(:'sh1_id', 'wants_bargain', 'просит минус 3000') \gset d1_

set role postgres;
insert into publication_channels (object_id, channel, status, last_sync_at)
values (:'obj1', 'lalafo', 'exported', now());
set role anon;
set request.jwt.claims = '{"role":"anon"}';

select app.owner_report(:'t1_token') as rep \gset
select test.ok(:'rep' is not null, 'отчёт отдан по действующему токену');

select test.eq(
  (app.owner_report(:'t1_token') -> 'object' ->> 'address'), 'Чүй 120, кв. 5',
  'в отчёте адрес объекта собственника');
select test.eq(
  (app.owner_report(:'t1_token') -> 'showings' ->> 'done')::int, 1,
  'отчёт показывает состоявшийся показ');
select test.eq(
  (app.owner_report(:'t1_token') -> 'showings' -> 'outcomes' ->> 'wants_bargain')::int, 1,
  'реакция клиента показана структурно');
select test.eq(
  jsonb_array_length(app.owner_report(:'t1_token') -> 'channels'), 1,
  'отчёт показывает каналы размещения');
select test.eq(
  (app.owner_report(:'t1_token') -> 'interest' ->> 'matches')::int, 1,
  'отчёт показывает число заинтересованных');

-- ---- 10ж. Чего в отчёте нет ----------------------------------------------
-- Ни комиссии, ни агентов, ни имён клиентов, ни свободного текста с показа.
select test.ok(
  app.owner_report(:'t1_token')::text not like '%минус 3000%',
  'свободный текст с показа в отчёт не попал');
select test.ok(
  app.owner_report(:'t1_token')::text not like '%Жумаев%',
  'имени клиента в отчёте нет');
select test.ok(
  app.owner_report(:'t1_token')::text not like '%commission%'
  and app.owner_report(:'t1_token')::text not like '%agent%',
  'ни комиссии, ни агентов в отчёте нет');

-- ---- 10з. Анониму доступна только функция ---------------------------------
-- Перебрать или прочитать токены нечем.
select test.throws(
  $$select token from owner_access limit 1$$,
  'permission denied',
  'таблица токенов анониму недоступна');

select test.ok(app.owner_report('00000000000000000000000000000000') is null,
  'выдуманный токен не открывает ничего');
select test.ok(app.owner_report('не токен') is null,
  'мусор вместо токена не открывает ничего');

-- ---- 10з-бис. Создание объекта это не изменение цены ----------------------
-- В журнале у вставки в diff лежит вся строка, поэтому без фильтра по
-- действию отчёт сообщал бы собственнику о правке цены, которой не было.
select test.eq(
  (app.owner_report(:'t1_token') -> 'price_changes' ->> 'count')::int, 0,
  'цену не правили — изменений ноль');

set role postgres;
update objects set price = 88000 where id = :'obj1';
set role anon;
select test.eq(
  (app.owner_report(:'t1_token') -> 'price_changes' ->> 'count')::int, 1,
  'после правки цены изменение одно');

-- ---- 10и. Просмотры считаются --------------------------------------------
select test.ok(
  (app.owner_report(:'t1_token') -> 'report' ->> 'views')::int >= 2,
  'просмотры отчёта считаются');

-- ---- 10к. Отзыв закрывает доступ -----------------------------------------
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.eq(revoke_owner_access(:'obj1', :'contact_owner'), 1,
  'ссылка отозвана');

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(app.owner_report(:'t1_token') is null,
  'отозванный токен не открывает ничего');

-- ---- 10л. Истёкший токен тоже не работает --------------------------------
set role postgres;
insert into owner_access (object_id, contact_id, token, issued_by_agent_id, expires_at)
values (:'obj1', :'contact_owner', 'ffffffffffffffffffffffffffffffff',
        :'agent_aibek', now() - interval '1 day');
set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(app.owner_report('ffffffffffffffffffffffffffffffff') is null,
  'истёкший токен не открывает ничего');
