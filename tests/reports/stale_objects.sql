-- ОТЧЁТ по подвисшим объектам. Не инвариант: правил не вводит, ничего не
-- запрещает. Проверяется, что отчёт называет ровно те объекты, по которым
-- действительно что-то не так, и молчит про остальные.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- ---- Чистый объект в отчёт не попадает -----------------------------------
-- obj1 из сценария приёмки: мандат активен, объект опубликован, подтверждён
-- сегодня. Фотографий у него нет, поэтому одна причина всё же найдётся —
-- и это правильно: объект без фотографий в каталоге это и есть недоделка.
select test.eq(
  (select reasons from stale_objects_v where object_id = :'obj1'),
  array['нет фотографий']::text[],
  'у опубликованного объекта без фотографий ровно одна причина');

select test.eq(
  (select severity from stale_objects_v where object_id = :'obj1'), 'warning',
  'отсутствие фотографий это предупреждение, а не срочность');

-- Добавим фотографию — и объект должен исчезнуть из отчёта целиком.
select * from attach_photo(:'obj1',
  'objects/00000000-0000-0000-0000-0000000b0001/00000000000000000000000000000a01.jpg',
  'image/jpeg') \gset ph_

select test.eq(
  test.visible_count(format($$select 1 from stale_objects_v where object_id = %L$$, :'obj1')),
  0::bigint, 'объект без замечаний в отчёт не попадает');

-- ---- Давно не подтверждали ------------------------------------------------
-- Сдвинуть actual_at назад нельзя (инвариант 5), поэтому объект заводится
-- сразу с нужной давностью: на вставке значение принимается.
set role postgres;
insert into objects (id, kind, deal_type, address, zone, price, actual_at, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fc001', 'flat', 'sale', 'Давно не подтверждали',
        'Центр', 60000, now() - interval '40 days', :'agent_aibek');
insert into object_ownerships (object_id, contact_id, role, share)
values ('00000000-0000-0000-0000-0000000fc001', :'contact_owner', 'owner', 1);
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000fc001', 'non_exclusive', 60000, :'agent_aibek', true, 'active');
update objects set publication_state = 'published'
 where id = '00000000-0000-0000-0000-0000000fc001';
set role authenticated;

-- Фотографию этому объекту не добавляем намеренно: любая правка фотографий
-- поднимает actual_at (инвариант 5), а вернуть давность назад нельзя — он
-- разрешает двигать actual_at только вперёд. Значит и причин будет две.

select test.ok(
  (select needs_confirmation from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc001'),
  'объект без подтверждения сорок дней отмечен');

select test.eq(
  (select reasons from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc001'),
  array['давно не подтверждали', 'нет фотографий']::text[],
  'названы обе причины, и подтверждение идёт раньше фотографий');

select test.eq(
  (select severity from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc001'), 'critical',
  'больше двух порогов без подтверждения это уже срочно');

-- ---- Просроченный мандат: страховка от неработающего планировщика --------
-- Активировать мандат с прошедшим сроком нельзя (инвариант 1), а вот срок
-- уже действующего сократить можно — так и выглядит «договор кончился, а
-- app.expire_mandates() ещё не пробежала».
set role postgres;
-- Договор заключён месяц назад и кончился три дня назад: valid_to раньше
-- valid_from схема не разрешает, и это правильно.
update mandates set valid_from = current_date - 30, valid_to = current_date - 3
 where object_id = '00000000-0000-0000-0000-0000000fc001' and status = 'active';
set role authenticated;

select test.ok(
  (select mandate_expired from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc001'),
  'просроченный мандат отмечен');

select test.eq(
  (select reasons[1] from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc001'),
  'срок договора вышел',
  'просроченный договор идёт первой причиной');

-- После прогона планировщика объект уходит из каталога, а с ним и из отчёта:
-- мандат перестаёт быть активным.
select test.ok(app.expire_mandates() >= 1, 'планировщик погасил просроченные мандаты');
select test.eq(
  test.visible_count($$select 1 from stale_objects_v
                        where object_id = '00000000-0000-0000-0000-0000000fc001'$$),
  0::bigint, 'после работы планировщика объект из отчёта ушёл');

select test.eq(
  (select publication_state from objects
    where id = '00000000-0000-0000-0000-0000000fc001'), 'withdrawn'::publication_state,
  'и из каталога тоже');

-- ---- Мандат есть, объекта в каталоге нет ---------------------------------
set role postgres;
insert into objects (id, kind, deal_type, address, zone, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fc002', 'flat', 'sale', 'Черновик с мандатом',
        'Юг', 70000, :'agent_bakyt');
insert into object_ownerships (object_id, contact_id, role, share)
values ('00000000-0000-0000-0000-0000000fc002', :'contact_owner', 'owner', 1);
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000fc002', 'exclusive', 70000, :'agent_bakyt', true, 'active');
set role authenticated;

select test.eq(
  (select reasons from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc002'),
  array['мандат есть, объекта в каталоге нет']::text[],
  'договор работает, а объект не опубликован');

-- ---- Договор скоро кончится ----------------------------------------------
set role postgres;
update mandates set valid_to = current_date + 3
 where object_id = '00000000-0000-0000-0000-0000000fc002' and status = 'active';
set role authenticated;

select test.ok(
  (select mandate_expiring from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc002'),
  'договор, который кончается через три дня, отмечен');

select test.eq(
  (select severity from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc002'), 'warning',
  'скоро кончится это предупреждение');

-- Просроченный договор срочен сам по себе, даже когда объект свежий и по
-- нему больше нет никаких замечаний.
set role postgres;
update mandates set valid_from = current_date - 30, valid_to = current_date - 1
 where object_id = '00000000-0000-0000-0000-0000000fc002' and status = 'active';
set role authenticated;

select test.ok(
  (select days_since_confirmed from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc002') <= 1,
  'объект подтверждён сегодня, несвежим его не назвать');

select test.eq(
  (select severity from stale_objects_v
    where object_id = '00000000-0000-0000-0000-0000000fc002'), 'critical',
  'просроченный договор срочен сам по себе');

-- ---- Ошибка размещения на площадке ---------------------------------------
set role postgres;
insert into publication_channels (object_id, channel, status, last_error)
values (:'obj2', 'lalafo', 'error', 'объявление отклонено модерацией');
set role authenticated;

select test.ok(
  (select channel_error from stale_objects_v where object_id = :'obj2'),
  'ошибка размещения попала в отчёт');

-- ---- Свод по агентам ------------------------------------------------------
select test.ok(
  (select total from stale_summary_v where listing_agent_id = :'agent_bakyt') >= 1,
  'свод считает подвисшие объекты по агенту');

select test.eq(
  (select not_published from stale_summary_v where listing_agent_id = :'agent_bakyt'), 1::bigint,
  'свод отдельно считает неопубликованные при живом договоре');

-- ---- Анониму отчёт недоступен ---------------------------------------------
set role anon;
set request.jwt.claims = '{"role":"anon"}';
-- Ожидается отказ именно по представлению. Проверка на любое «permission
-- denied» прошла бы и в случае, когда отчёт анониму выдали: представление
-- работает правами вызывающего, и аноним упёрся бы в таблицу мандатов —
-- другой отказ, тот же текст.
select test.throws(
  $$select 1 from stale_objects_v limit 1$$,
  'permission denied for view stale_objects_v',
  'отчёт по подвисшим объектам анониму недоступен');
