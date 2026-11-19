-- ПРИЁМКА. Пять критериев из задания, проверяемые целиком.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- 1. Один собственник с ТРЕМЯ объектами и один клиент с ДВУМЯ потребностями
--    дают множественные подборы В ОБЕ СТОРОНЫ.
-- ===========================================================================

select test.eq(
  (select count(*)::int from object_ownerships
    where contact_id = :'contact_owner' and role = 'owner'), 3,
  'у одного собственника три объекта');

select test.eq(
  (select count(*)::int from requirements where contact_id = :'contact_client'
     and status not in ('closed', 'lost')), 2,
  'у одного клиента две одновременные потребности');

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- Все шесть сочетаний: 3 объекта × 2 потребности.
select create_match(:'obj1', :'req1');
select create_match(:'obj2', :'req1');
select create_match(:'obj3', :'req1');
select create_match(:'obj1', :'req2');
select create_match(:'obj2', :'req2');
select create_match(:'obj3', :'req2');

-- Сторона потребности: одна потребность → три объекта.
select test.eq(
  (select count(*)::int from matches where requirement_id = :'req1'), 3,
  'от потребности: три подбора на три объекта');

-- Сторона объекта: один объект → две потребности.
select test.eq(
  (select count(*)::int from matches where object_id = :'obj1'), 2,
  'от объекта: два подбора на две потребности');

select test.eq((select count(*)::int from matches), 6,
  'всего шесть подборов — связь много-ко-многим работает в обе стороны');

-- Повторный подбор той же пары дубликат не создаёт.
select create_match(:'obj1', :'req1');
select test.eq((select count(*)::int from matches), 6,
  'повторный подбор той же пары дубликат не создаёт');
reset role;

-- ===========================================================================
-- 2. Объект без активного мандата невозможно опубликовать.
--    Этот тест обязан падать, если публикация удастся.
-- ===========================================================================

insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fa001', 'flat', 'sale', 'Без мандата', 55000, :'agent_aibek');

select test.throws(
  $$update objects set publication_state = 'published'
     where id = '00000000-0000-0000-0000-0000000fa001'$$,
  'INVARIANT_1', 'публикация без мандата: прямой UPDATE отклонён');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  $$select publish_object('00000000-0000-0000-0000-0000000fa001')$$,
  'INVARIANT_1', 'публикация без мандата: функция кабинета отклонена');
select test.throws(
  $$insert into publication_channels (object_id, channel, status)
    values ('00000000-0000-0000-0000-0000000fa001', 'house_kg', 'exported')$$,
  'INVARIANT_1', 'публикация без мандата: выгрузка в канал отклонена');
reset role;

select test.eq(
  (select publication_state from objects where id = '00000000-0000-0000-0000-0000000fa001'),
  'draft'::publication_state, 'объект так и остался черновиком');

-- ===========================================================================
-- 3. Закрытие сделки закрывает мандат и потребность
--    и фиксирует ДВЕ доли комиссии.
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select id as m_id from matches
 where object_id = :'obj1' and requirement_id = :'req1' \gset
select * from create_deal_from_match(:'m_id') \gset d_
select * from close_deal(:'d_id', 90000) \gset c_

select test.eq((select status from mandates where id = :'mandate1'),
  'closed_by_deal'::mandate_status, 'закрытие сделки закрыло мандат');
select test.eq((select status from requirements where id = :'req1'),
  'closed'::requirement_status, 'закрытие сделки закрыло потребность');

-- Две доли, именно две, и они сходятся в итог.
select test.eq(:'c_commission_total'::numeric, 1800.00::numeric,
  'итоговая комиссия = 2% от финальных 90000');
select test.eq(:'c_listing_share'::numeric, 900.00::numeric,
  'доля listing-агента зафиксирована');
select test.eq(:'c_closing_share'::numeric, 900.00::numeric,
  'доля closing-агента зафиксирована');
select test.ok(
  (:'c_listing_share'::numeric + :'c_closing_share'::numeric) = :'c_commission_total'::numeric,
  'две доли складываются ровно в итог');
select test.eq(:'c_listing_agent_id'::text, :'agent_aibek'::text,
  'доля listing достаётся агенту из мандата');
select test.eq(:'c_closing_agent_id'::text, :'agent_bakyt'::text,
  'доля closing достаётся агенту из подбора');
reset role;

-- ===========================================================================
-- 4. Агент НЕ из сделки не получает телефон собственника
--    ни через UI, ни через API.
-- ===========================================================================
-- «Через API» означает прямой запрос к таблицам и представлениям, минуя
-- кабинет: именно так PostgREST отдаёт данные.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.eq(test.visible_count(
  format($$select 1 from contact_phones where contact_id = %L$$, :'contact_owner')),
  0::bigint, 'напрямую из contact_phones — ничего');

select test.eq(test.visible_count(
  format($$select 1 from contacts where id = %L$$, :'contact_owner')),
  0::bigint, 'напрямую из contacts — ничего');

-- Обход через связь объекта.
select test.eq(test.visible_count(format($$
  select 1 from object_ownerships oo
    join contact_phones cp on cp.contact_id = oo.contact_id
   where oo.object_id = %L$$, :'obj1')),
  0::bigint, 'обход join-ом через object_ownerships — ничего');

-- Обход через потребность и сделку.
select test.eq(test.visible_count($$
  select 1 from deals d
    join requirements r  on r.id = d.requirement_id
    join contact_phones cp on cp.contact_id = r.contact_id$$),
  0::bigint, 'обход join-ом через сделку и потребность — ничего');

-- При этом работать ему есть с чем.
select test.ok(test.visible_count($$select 1 from objects$$) > 0,
  'объекты агенту видны');
select test.ok(test.visible_count($$select 1 from mandates$$) > 0,
  'условия мандатов агенту видны');
select test.ok(test.visible_count($$select 1 from deal_commission_v$$) > 0,
  'комиссия агенту видна');
reset role;

-- ===========================================================================
-- 5. Публичный каталог.
-- ===========================================================================
-- На чистой базе «как до изменений» сравнивать не с чем: прежнего каталога
-- не существовало. Проверяется то, что проверяемо: витрина открыта анониму,
-- показывает только опубликованное и не выносит наружу ни комиссию, ни контакты.

set role anon;
select test.ok(test.visible_count($$select 1 from public_catalog_v$$) > 0,
  'публичный каталог открыт анониму');

select test.eq(test.visible_count(
  format($$select 1 from public_catalog_v where id = %L$$,
         '00000000-0000-0000-0000-0000000fa001')),
  0::bigint, 'неопубликованный объект в каталог не попадает');

select test.throws($$select 1 from deal_commission_v$$, 'permission denied',
  'комиссия анониму недоступна');
select test.throws($$select 1 from contacts$$, 'permission denied',
  'контакты анониму недоступны');
select test.throws($$select 1 from mandates$$, 'permission denied',
  'мандаты анониму недоступны');
reset role;

-- Витрина не содержит колонок, которых в публичной части быть не должно.
select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'public_catalog_v'
      and column_name in ('commission_total', 'listing_share', 'closing_share',
                          'created_by_agent_id', 'publication_state')), 0,
  'в витрине нет ни комиссии, ни агента, ни внутреннего состояния');

-- ===========================================================================
-- Пункт 3 порядка работ: перенос объектов без мандата
-- ===========================================================================
-- На чистой базе переносить нечего, но путь обязан работать: объект без
-- мандата получает АКТИВНЫЙ мандат с contract_confirmed = false, сохраняя
-- агента и все поля.

select price as price_before, created_by_agent_id as agent_before,
       actual_at as actual_before, address as addr_before
  from objects where id = '00000000-0000-0000-0000-0000000fa001' \gset

select test.eq((select count(*)::int from app.backfill_missing_mandates()), 1,
  'перенос выдал мандат объекту, у которого его не было');

select test.eq(
  (select status from mandates where object_id = '00000000-0000-0000-0000-0000000fa001'),
  'active'::mandate_status, 'мандат переноса АКТИВЕН — каталог не падает');
select test.ok(
  (select not contract_confirmed from mandates
    where object_id = '00000000-0000-0000-0000-0000000fa001'),
  'договор помечен как требующий подтверждения');
select test.eq(
  (select listing_agent_id from mandates
    where object_id = '00000000-0000-0000-0000-0000000fa001')::text,
  :'agent_before'::text, 'текущий агент объекта сохранён как listing-агент');

-- Ни одно поле объекта не тронуто.
select test.eq((select price from objects where id = '00000000-0000-0000-0000-0000000fa001'),
  :'price_before'::numeric, 'цена объекта не изменилась');
select test.eq((select address from objects where id = '00000000-0000-0000-0000-0000000fa001'),
  :'addr_before', 'адрес объекта не изменился');
select test.eq((select actual_at from objects where id = '00000000-0000-0000-0000-0000000fa001'),
  :'actual_before'::timestamptz, 'actual_at объекта не сдвинулся: перенос не правка');

-- И теперь объект публикуется, как и было задумано.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(
  (publish_object('00000000-0000-0000-0000-0000000fa001')).publication_state,
  'published'::publication_state,
  'после переноса объект публикуется');
reset role;

-- Повторный прогон переноса ничего не дублирует.
select test.eq((select count(*)::int from app.backfill_missing_mandates()), 0,
  'повторный прогон переноса идемпотентен');
