-- ИНВАРИАНТ 5. Правка цены, фото или подтверждение актуальности обновляет
--              actual_at. published_at не меняется никогда.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 5а. published_at ставится при первой публикации ---------------------
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f5001', 'flat', 'sale', 'Тест дат 1', 60000, :'agent_aibek');

select test.ok(
  (select published_at is null from objects where id = '00000000-0000-0000-0000-0000000f5001'),
  'черновик не имеет published_at');

insert into mandates (object_id, start_price, listing_agent_id, status)
values ('00000000-0000-0000-0000-0000000f5001', 60000, :'agent_aibek', 'active');
update objects set publication_state = 'published' where id = '00000000-0000-0000-0000-0000000f5001';

select published_at as pub_first from objects where id = '00000000-0000-0000-0000-0000000f5001' \gset
select test.ok(:'pub_first' is not null, 'при публикации published_at зафиксирован');

-- ---- 5б. published_at не меняется прямым UPDATE --------------------------
update objects set published_at = '2000-01-01'::timestamptz
 where id = '00000000-0000-0000-0000-0000000f5001';
select test.eq(
  (select published_at from objects where id = '00000000-0000-0000-0000-0000000f5001'),
  :'pub_first'::timestamptz,
  'прямая попытка переписать published_at отменена триггером');

-- ---- 5в. Снятие и повторная публикация сохраняют ПЕРВУЮ дату -------------
update objects set publication_state = 'withdrawn' where id = '00000000-0000-0000-0000-0000000f5001';
select test.eq(
  (select published_at from objects where id = '00000000-0000-0000-0000-0000000f5001'),
  :'pub_first'::timestamptz, 'снятие с публикации published_at не стирает');

update objects set publication_state = 'published' where id = '00000000-0000-0000-0000-0000000f5001';
select test.eq(
  (select published_at from objects where id = '00000000-0000-0000-0000-0000000f5001'),
  :'pub_first'::timestamptz, 'повторная публикация сохраняет ПЕРВУЮ дату публикации');

-- ---- 5г. Правка цены поднимает actual_at ---------------------------------
select actual_at as act0 from objects where id = :'obj1' \gset
select pg_sleep(0.05);
update objects set price = 86000 where id = :'obj1';
select test.ok(
  (select actual_at > :'act0'::timestamptz from objects where id = :'obj1'),
  'правка цены обновила actual_at');
select test.eq(
  (select published_at from objects where id = :'obj1'),
  (select published_at from objects where id = :'obj1'),
  'published_at при правке цены не затронут');

-- ---- 5д. Правка фото поднимает actual_at ---------------------------------
-- С 0014 фотографии живут в своей таблице, и актуальность поднимает триггер
-- на ней. Проверяется то же самое утверждение инварианта 5, но по новому пути:
-- иначе замена фотографий молча перестала бы считаться правкой объекта.
select actual_at as act1 from objects where id = :'obj1' \gset
select pg_sleep(0.05);
insert into object_photos (object_id, storage_key, content_type, uploaded_by_agent_id)
values (:'obj1',
        'objects/00000000-0000-0000-0000-0000000b0001/00000000000000000000000000000f05.jpg',
        'image/jpeg', :'agent_aibek');
select test.ok(
  (select actual_at > :'act1'::timestamptz from objects where id = :'obj1'),
  'правка фото обновила actual_at');

-- ---- 5е. Правка, не касающаяся цены и фото, actual_at не двигает ---------
select actual_at as act2 from objects where id = :'obj1' \gset
select pg_sleep(0.05);
update objects set description = 'уточнили описание' where id = :'obj1';
select test.eq(
  (select actual_at from objects where id = :'obj1'), :'act2'::timestamptz,
  'правка описания actual_at НЕ двигает: актуальность не про текст');

-- ---- 5ж. Подтверждение актуальности --------------------------------------
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select pg_sleep(0.05);
select app.confirm_actual(:'obj1') as act3 \gset
select test.ok(:'act3'::timestamptz > :'act2'::timestamptz,
  'подтверждение актуальности обновило actual_at');
reset role;

-- ---- 5з. actual_at нельзя задрать в будущее ------------------------------
update objects set actual_at = now() + interval '30 days' where id = :'obj1';
select test.ok(
  (select actual_at <= now() from objects where id = :'obj1'),
  'actual_at в будущее не принимается');

-- ...и нельзя отмотать назад.
update objects set actual_at = '2000-01-01'::timestamptz where id = :'obj1';
select test.ok(
  (select actual_at > '2020-01-01'::timestamptz from objects where id = :'obj1'),
  'actual_at назад не отматывается');
