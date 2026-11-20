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

-- ---- 11з. Удаление оставляет порядок сплошным ------------------------------
-- Обложка — это первая фотография, а не отдельный флаг. Значит удаление
-- первой обязано сделать обложкой следующую, а дыры в нумерации (0, 2, 3)
-- означали бы объект без нулевой позиции, то есть без обложки.
--
-- Объект очищается от фотографий предыдущих проверок: иначе утверждения
-- ниже считали бы не то, что проверяют.
set role postgres;
delete from object_photos where object_id = :'obj1';

set role authenticated;
set request.jwt.claims = :'claims_aibek';

select attach_photo(:'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01.webp', 'image/webp');
select attach_photo(:'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02.webp', 'image/webp');
select attach_photo(:'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03.webp', 'image/webp');

select test.eq(
  (select array_agg(sort_order order by sort_order)::int[] from object_photos where object_id = :'obj1'),
  array[0, 1, 2], 'порядок сплошной после трёх добавлений');

select test.eq(
  delete_photo(:'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01.webp'),
  'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01.webp',
  'удаление возвращает ключ, чтобы вызывающий убрал файл');

select test.eq(
  (select array_agg(sort_order order by sort_order)::int[] from object_photos where object_id = :'obj1'),
  array[0, 1], 'после удаления первой порядок снова сплошной от нуля');

select test.eq(
  (select storage_key from object_photos where object_id = :'obj1' and sort_order = 0),
  'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02.webp',
  'обложкой стала следующая фотография, а не пустота');

select test.throws(
  format($$select delete_photo(%L, 'objects/00000000-0000-0000-0000-0000000b0001/ffffffffffffffffffffffffffffff99.webp')$$, :'obj1'),
  'INVARIANT_11: фотографии',
  'чужой ключ не удалить');

-- ---- 11и. Обложка меняется одним действием ---------------------------------
select test.eq(
  set_cover(:'obj1', 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03.webp'),
  2, 'смена обложки переставляет все фотографии объекта');
select test.eq(
  (select storage_key from object_photos where object_id = :'obj1' and sort_order = 0),
  'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03.webp',
  'выбранная стала обложкой');
select test.eq(
  (select array_agg(sort_order order by sort_order)::int[] from object_photos where object_id = :'obj1'),
  array[0, 1], 'и порядок остался сплошным');

-- ---- 11к. Предел числа фотографий ------------------------------------------
-- Не вкусовщина: у объекта с сотней фотографий другая страница каталога и
-- другие расходы на хранение.
do $$
declare i integer;
begin
  for i in 10 .. (app.max_photos_per_object() + 8) loop
    exit when (select count(*) from object_photos where object_id = '00000000-0000-0000-0000-0000000b0001')
              >= app.max_photos_per_object();
    perform attach_photo('00000000-0000-0000-0000-0000000b0001',
      format('objects/00000000-0000-0000-0000-0000000b0001/bbbbbbbbbbbbbbbbbbbbbbbbbbbbb%s.webp', lpad(i::text, 3, '0')),
      'image/webp');
  end loop;
end $$;

select test.eq(
  (select count(*)::int from object_photos where object_id = :'obj1'),
  app.max_photos_per_object(), 'набрали предел');

select test.throws(
  format($$select attach_photo(%L, 'objects/00000000-0000-0000-0000-0000000b0001/cccccccccccccccccccccccccccccc01.webp', 'image/webp')$$, :'obj1'),
  'это предел',
  'сверх предела фотографию не добавить');

-- ---- 11л. Фотографии чужого объекта не трогать -----------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select delete_photo(%L, 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03.webp')$$, :'obj1'),
  'INVARIANT_11: фотографии удаляет listing-агент действующего мандата',
  'чужую фотографию не удалить');
select test.throws(
  format($$select set_cover(%L, 'objects/00000000-0000-0000-0000-0000000b0001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02.webp')$$, :'obj1'),
  'INVARIANT_11: порядок фотографий меняет listing-агент действующего мандата',
  'чужую обложку не поменять');

-- ---- 11м. Кабинет видит фотографии черновика, каталог — нет ----------------
-- Публичная витрина отдаёт фотографии только опубликованных объектов, и это
-- инвариант. Но агент загружает их ДО публикации, поэтому у кабинета своё
-- представление — с правами вызывающего, а не для всех.
set role postgres;
update objects set publication_state = 'draft' where id = :'obj1';

set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.ok(
  (select count(*) from cabinet_photo_v where object_id = :'obj1') > 0,
  'агент видит фотографии неопубликованного объекта');

-- Представление собрано с правами ВЫЗЫВАЮЩЕГО. Без этого оно читалось бы
-- правами владельца, то есть в обход построчных политик, и неодобренный
-- агент — у него роль authenticated и право на представление — увидел бы
-- фотографии всего агентства. Мутация, снимавшая security_invoker, выживала:
-- для одобренного агента разницы нет, и проверять надо именно неодобренного.
set request.jwt.claims = :'claims_pending';
select test.eq(
  (select count(*)::int from cabinet_photo_v),
  0, 'неодобренный агент не видит ни одной фотографии');

set role postgres; set role anon;
select test.eq(
  (select count(*)::int from public_photo_v where object_id = :'obj1'),
  0, 'в публичной витрине фотографий черновика нет');
select test.throws(
  $$select * from cabinet_photo_v$$,
  'permission denied for view cabinet_photo_v',
  'и кабинетное представление анониму недоступно');
