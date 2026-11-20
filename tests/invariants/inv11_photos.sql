-- ИНВАРИАНТ 11. Фотография публично доступна ровно тогда, когда объект
--               опубликован. Снятие с публикации закрывает и фотографии.
\i tests/actors.sql
\set ON_ERROR_STOP on

\set key1 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaabbbbccccddddeeeeffff0001.jpg'
\set key2 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaabbbbccccddddeeeeffff0002.jpg'
\set key3 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaabbbbccccddddeeeeffff0003.webp'

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- ---- 11а. Загружает listing-агент действующего мандата -------------------
select * from attach_photo(:'obj1', :'key1', 'image/jpeg', 1600, 1200, 240000) \gset p1_
select test.eq(:'p1_sort_order'::int, 0, 'первая фотография встала обложкой');
select test.eq(:'p1_uploaded_by_agent_id'::text, :'agent_aibek'::text,
  'загрузивший агент это текущий агент');

select * from attach_photo(:'obj1', :'key2', 'image/jpeg', 1600, 1200, 220000) \gset p2_
select test.eq(:'p2_sort_order'::int, 1, 'порядок выводится на сервере, а не приходит в запросе');

-- ---- 11б. Чужой агент фотографии не добавляет ----------------------------
-- Мандат на obj1 у Айбека. Бакыт ведёт клиента, но за объект не отвечает.
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select attach_photo(%L, %L, 'image/jpeg')$$, :'obj1', :'key3'),
  'INVARIANT_11',
  'не владелец мандата фотографию не добавит');
set request.jwt.claims = :'claims_aibek';

-- ---- 11в. Ключ не выходит за пределы каталога объекта --------------------
-- Форма ключа ограничена проверкой схемы, поэтому обход пути невозможен
-- по построению, а не по внимательности обработчика.
select test.throws(
  format($$select attach_photo(%L, %L, 'image/jpeg')$$,
         :'obj1', 'objects/../../etc/passwd'),
  'object_photos_storage_key_check',
  'ключ с обходом пути отклонён');

select test.throws(
  format($$select attach_photo(%L, %L, 'image/svg+xml')$$,
         :'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaabbbbccccddddeeeeffff0009.jpg'),
  'object_photos_content_type_check',
  'svg как тип фотографии не принимается');

-- ---- 11г. Публично видны фотографии опубликованного объекта --------------
set role anon;
set request.jwt.claims = '{"role":"anon"}';

select test.eq(
  test.visible_count(format($$select 1 from public_photo_v where object_id = %L$$, :'obj1')),
  2::bigint, 'фотографии опубликованного объекта видны публично');

select test.eq(
  (select array_length(photos, 1) from public_catalog_v where id = :'obj1'),
  2, 'витрина отдаёт ключи фотографий');

select test.eq(
  (select photos[1] from public_catalog_v where id = :'obj1'), :'key1',
  'первой идёт обложка');

-- Сама таблица анониму недоступна: список фотографий неопубликованного
-- объекта не достать ни перебором, ни join-ом.
select test.throws(
  $$select storage_key from object_photos limit 1$$,
  'permission denied',
  'таблица фотографий анониму недоступна');

-- ---- 11д. Снятие с публикации закрывает фотографии -----------------------
-- Главное утверждение инварианта: доступность следует состоянию объекта,
-- без переноса файлов и без чистки кешей хранилища.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select withdraw_object(:'obj1') \gset w_

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.eq(
  test.visible_count(format($$select 1 from public_photo_v where object_id = %L$$, :'obj1')),
  0::bigint, 'после снятия с публикации фотографии публично недоступны');

-- Возврат в каталог возвращает и фотографии.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select publish_object(:'obj1') \gset pub_
set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.eq(
  test.visible_count(format($$select 1 from public_photo_v where object_id = %L$$, :'obj1')),
  2::bigint, 'после возврата в каталог фотографии снова доступны');

-- ---- 11е. Правка фотографий поднимает актуальность (инвариант 5) ---------
set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- Отодвинуть actual_at назад нельзя — инвариант 5 разрешает двигать его
-- только вперёд, — поэтому сравниваем с запомненным значением.
select actual_at as act_before from objects where id = :'obj1' \gset
select pg_sleep(0.05);

select * from attach_photo(:'obj1', :'key3', 'image/webp', 1200, 900, 90000) \gset p3_
select test.ok(
  (select actual_at from objects where id = :'obj1') > :'act_before'::timestamptz,
  'добавление фотографии подняло actual_at');

-- ---- 11ж. Порядок меняется только целиком --------------------------------
-- Частичный список оставил бы остальные фотографии на старых местах и
-- поменял бы обложку незаметно.
select test.throws(
  format($$select reorder_photos(%L, array[%L]::text[])$$, :'obj1', :'key2'),
  'INVARIANT_11',
  'частичный список для перестановки отклонён');

select test.throws(
  format($$select reorder_photos(%L, array[%L, %L, %L]::text[])$$,
         :'obj1', :'key2', :'key1',
         'objects/00000000-0000-0000-0000-0000000b0002/aaaaaaaabbbbccccddddeeeeffff0007.jpg'),
  'INVARIANT_11',
  'чужой ключ среди перечисленных отклонён');

select test.eq(reorder_photos(:'obj1', array[:'key3', :'key1', :'key2']::text[]), 3,
  'порядок переставлен целиком');

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.eq(
  (select photos[1] from public_catalog_v where id = :'obj1'), :'key3',
  'обложкой стала переставленная наверх фотография');

-- ---- 11з. Фотография в журнале (инвариант 7) ------------------------------
set role authenticated;
set request.jwt.claims = :'claims_admin';
select test.ok(
  (select count(*) from audit_log where entity_type = 'photo') >= 3,
  'загрузки фотографий записаны в журнал');
