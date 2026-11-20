-- ИНВАРИАНТ 19. Объект заводится только вместе с собственником и договором.
--
-- Повод записан на экране кабинета: объект «Черновик без мандата», с которым
-- нельзя ничего — ни опубликовать, ни добавить фотографии, ни отчитаться
-- собственнику, потому что собственника нет. Запись есть, толку нет, а в
-- отчёте о подвисших объектах она занимает строку.
--
-- Три вещи, которые в жизни происходят одним разговором с собственником,
-- в базе были тремя независимыми вставками — и между ними можно было
-- остановиться.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- ---- 19а. Прямая вставка объекта запрещена --------------------------------
-- Без этого правило выше — совет: агент заводит объект мимо функции и
-- получает ровно тот черновик, из-за которого всё и затевалось.
select test.throws(
  $$insert into objects (kind, deal_type, address, price, created_by_agent_id)
    values ('flat', 'sale', 'Мимо функции 1', 50000, app.current_agent_id())$$,
  'permission denied for table objects',
  'объект напрямую в таблицу не вставить');

-- ---- 19б. Создание заводит сразу три вещи ---------------------------------
select id as new_obj from create_object(
  'flat', 'sale', 'Токтогула 100, кв. 5', 72000,
  p_owner_name => 'Жаныбек Осмонов', p_owner_phone => '0700 55 44 33',
  p_zone => 'Центр', p_rooms => 2::smallint, p_area => 56.5,
  p_floor => 3::smallint, p_floors_total => 9::smallint,
  p_contract_confirmed => true) \gset

select test.eq(
  (select count(*)::int from objects where id = :'new_obj'),
  1, 'объект создан');
select test.eq(
  (select count(*)::int from object_ownerships
    where object_id = :'new_obj' and role = 'owner'),
  1, 'собственник привязан тем же действием');
select test.eq(
  (select count(*)::int from mandates
    where object_id = :'new_obj' and status = 'active'),
  1, 'договор заведён тем же действием');

-- Стартовая цена договора равна цене объекта: это один разговор, а не два.
select test.eq(
  (select start_price from mandates where object_id = :'new_obj'),
  (select price from objects where id = :'new_obj'),
  'стартовая цена договора совпадает с ценой объекта');

-- ---- 19в. Созданный объект сразу годен к работе ---------------------------
-- Это и есть проверка смысла: не «строка появилась», а «с ней можно
-- работать». Ровно этого не хватало черновику без мандата.
-- Проверяется результат, а не «вернулось не пусто». Для составной записи
-- `IS NOT NULL` в Postgres означает «ни одно поле не пусто», и у объекта без
-- этажа и площади это ложь — первая версия теста на этом и споткнулась.
select test.eq(
  (select publication_state from publish_object(:'new_obj')),
  'published'::publication_state,
  'созданный объект публикуется сразу: мандат уже есть');
select test.eq(
  (select sort_order from attach_photo(:'new_obj',
     'objects/' || :'new_obj' || '/dddddddddddddddddddddddddddddd01.webp',
     'image/webp')),
  0, 'и фотографии принимает: мандат на агенте');

-- ---- 19г. Телефон собственника нормализован -------------------------------
-- Пробел, записанный в README с первого дня: нормализация применялась только
-- к агентам, и «0700 55 44 33» с «+996700554433» были разными номерами.
select test.eq(
  (select cp.phone from contact_phones cp
     join object_ownerships oo on oo.contact_id = cp.contact_id
    where oo.object_id = :'new_obj'),
  '+996700554433', 'телефон собственника приведён к E.164');

-- ---- 19д. Тот же номер — тот же собственник -------------------------------
-- Собственник с двумя квартирами не должен превращаться в два контакта:
-- телефон у него один, и история работы с ним должна быть одна.
select id as second_obj from create_object(
  'flat', 'rent', 'Токтогула 100, кв. 6', 450,
  p_owner_name => 'Жаныбек О.', p_owner_phone => '+996 700 554433') \gset

select test.eq(
  (select count(distinct oo.contact_id)::int
     from object_ownerships oo
    where oo.object_id in (:'new_obj', :'second_obj')),
  1, 'оба объекта у одного собственника, а не у двух одинаковых');

-- ---- 19е. Без собственника объект не создать ------------------------------
select test.throws(
  $$select create_object('flat', 'sale', 'Без хозяина', 10000)$$,
  'INVARIANT_19: у объекта должен быть собственник',
  'объект без собственника не создаётся');

select test.throws(
  $$select create_object('flat', 'sale', 'Безымянный хозяин', 10000,
      p_owner_phone => '0700 99 88 77')$$,
  'INVARIANT_19: у нового собственника должно быть имя',
  'новый собственник без имени не заводится');

-- ---- 19ж. Чужой контакт не прицепить --------------------------------------
-- Функция security definer обходит построчные политики, поэтому право на
-- контакт проверяется явно. Иначе по угаданному идентификатору к объекту
-- прицепился бы чужой собственник — и телефон его стал бы виден.
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select create_object('flat', 'sale', 'Чужой собственник', 10000,
      p_contact_id => %L)$$, :'contact_owner'),
  'FORBIDDEN: этот контакт вам не виден',
  'чужой контакт к объекту не прицепить');

-- ---- 19з. Объект из объявления закрывает кандидата ------------------------
-- Иначе агент должен помнить про второе действие, а кандидат висит в пуле
-- закреплённым за ним.
set request.jwt.claims = :'claims_aibek';
set role collector;
select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','INV19-1','title','из объявления',
  'kind','flat','deal_type','sale','price',65000,'author','owner',
  'phone','0700 66 55 44')) as cand \gset

set role authenticated;
set request.jwt.claims = :'claims_aibek';
select claim_candidate(:'cand', 3);

select id as from_candidate from create_object(
  'flat', 'sale', 'Из объявления, кв. 1', 65000,
  p_owner_name => 'Собственник из объявления', p_owner_phone => '0700 66 55 44',
  p_candidate_id => :'cand') \gset

select test.eq(
  (select status::text from listing_candidates where id = :'cand'),
  'taken', 'кандидат закрыт тем же действием');
select test.eq(
  (select object_id from listing_candidates where id = :'cand'),
  :'from_candidate'::uuid, 'и указывает на созданный объект');

-- Телефон из объявления и телефон собственника — один номер, значит один
-- контакт, а не второй такой же.
select test.eq(
  (select count(*)::int from contact_phones where phone = '+996700665544'),
  1, 'телефон из объявления не породил второй контакт');

-- ---- 19и. Каталогу создание объектов недоступно ---------------------------
set role postgres; set role anon;
select test.throws(
  $$select create_object('flat', 'sale', 'От анонима', 1000,
      p_owner_name => 'Никто', p_owner_phone => '0700000000')$$,
  'permission denied for function create_object',
  'аноним объект не создаёт');
