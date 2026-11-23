-- ОТЧЁТ. Экспозиция объекта на нашем каталоге (миграция 0052).
--
-- Не инвариант: ничего не запрещается. Но на этих числах агент решает, что
-- делать с объектом, который висит, — и соврать ими легче, чем кажется.
--
-- Две вещи проверяются особенно.
--
-- Первая: счётчик нельзя превратить в СПОСОБ ПРОВЕРЯТЬ СУЩЕСТВОВАНИЕ
-- объектов. Функцию зовёт аноним, то есть кто угодно. Если бы она считала
-- любой идентификатор, по движению счётчика можно было бы узнать, есть ли у
-- нас неопубликованный объект с таким uuid.
--
-- Вторая: обращения считаются по about_object_id — «обращение ПРО этот
-- объект», а не по object_id, который означает «обращение превратилось в
-- этот объект». Поля стоят рядом, названия похожи, и перепутать их значит
-- посчитать в экспозицию то, что ею не является.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Открытие считается только у опубликованного
-- ---------------------------------------------------------------------------
set role postgres;
set request.jwt.claims = '{}';

-- Черновик без мандата: в каталоге его нет и быть не может (инвариант 1).
\set obj_draft '00000000-0000-0000-0000-0000000fe001'
insert into objects (id, kind, deal_type, address, zone, price, created_by_agent_id)
values (:'obj_draft', 'flat', 'sale', 'Черновик 1', 'Центр', 50000, :'agent_aibek');

select test.eq(
  (select publication_state::text from objects where id = :'obj1'),
  'published',
  'объект сценария приёмки опубликован: проверки ниже не вакуумны');

set role anon;

select app.note_object_view(:'obj1');
select app.note_object_view(:'obj1');
select app.note_object_view(:'obj_draft');
select app.note_object_view('00000000-0000-0000-0000-0000000fffff');

set role postgres;

select test.eq(
  (select views from object_views where object_id = :'obj1' and day = current_date),
  2,
  'два открытия за сутки легли одной строкой со счётчиком 2');

select test.eq(
  (select count(*)::int from object_views where object_id = :'obj_draft'),
  0,
  'неопубликованный объект не считается');

select test.eq(
  (select count(*)::int from object_views),
  1,
  'и несуществующий идентификатор тоже: строк ровно одна, от опубликованного');

-- Ответ одинаков у всех трёх случаев, и проверяется именно это.
--
-- Сравнить два void нельзя — первая версия этой проверки так и падала,
-- «operator does not exist: void = void». Да и сравнивать нечего: у функции
-- нет возвращаемого значения, и наблюдаемого поведения ровно два — упала или
-- нет, записала или нет. Оба и проверяются: оба вызова проходят без ошибки и
-- оба ничего не пишут. Если бы функция различала случаи — скажем, падала на
-- чужом идентификаторе, — по ней можно было бы перебором узнавать, какие
-- объекты у нас есть.
set role anon;
select app.note_object_view(:'obj_draft');
select app.note_object_view('00000000-0000-0000-0000-0000000fffff');
set role postgres;
select test.eq(
  (select count(*)::int from object_views),
  1,
  'ни неопубликованный, ни несуществующий не записались и не уронили вызов');

-- ---------------------------------------------------------------------------
-- Окна: неделя, месяц, всего
-- ---------------------------------------------------------------------------
-- Прошлые сутки вставляются напрямую: счётчик не защищён триггером времени,
-- и подделать его в тесте можно — в отличие от actual_at. Зато так
-- проверяются именно границы окон, а не то, умеет ли база складывать.

insert into object_views (object_id, day, views) values
  (:'obj1', current_date - 3,  5),    -- в неделю и в месяц
  (:'obj1', current_date - 10, 7),    -- только в месяц
  (:'obj1', current_date - 90, 11);   -- только во «всего»

-- Окна читаются ПОД АГЕНТОМ, а не под postgres. Первая версия читала их
-- владельцем базы, и проверка обходила тот самый путь, которым ходит
-- приложение: карточка объекта падала с «permission denied for table
-- object_views», а тест этого не видел. Поймал проход браузера.
set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.eq(
  (select views_7 from object_exposure_v where object_id = :'obj1'),
  7,  -- 2 сегодня + 5 трёхдневной давности
  'в неделю попало только то, что внутри недели');

select test.eq(
  (select views_30 from object_exposure_v where object_id = :'obj1'),
  14, -- 2 + 5 + 7
  'в месяц попало только то, что внутри месяца');

select test.eq(
  (select views_total from object_exposure_v where object_id = :'obj1'),
  25, -- 2 + 5 + 7 + 11
  'во «всего» попало всё');

select test.eq(
  (select last_view_day from object_exposure_v where object_id = :'obj1'),
  current_date,
  'последний день открытия — сегодняшний');

-- ---------------------------------------------------------------------------
-- Обращения: про объект, а не из объекта
-- ---------------------------------------------------------------------------

select test.eq(
  (select inquiries_total from object_exposure_v where object_id = :'obj1'),
  0,
  'обращений про объект пока нет: проверка ниже не вакуумна');

select * from register_inquiry('site', 'demand', 'каталог', 'Нургуль',
                               '0555 112 233', 'интересует эта квартира',
                               :'obj1') \gset inq1_

select test.eq(
  (select inquiries_total from object_exposure_v where object_id = :'obj1'),
  1,
  'обращение ПРО объект попало в экспозицию');

-- Обращение без указания объекта в экспозицию не попадает, даже если его
-- потом разберут в потребность или объект: это другое поле и другой смысл.
select * from register_inquiry('site', 'demand', 'каталог', 'Азамат',
                               '0555 112 244', 'ищу что-нибудь') \gset inq2_

select test.eq(
  (select inquiries_total from object_exposure_v where object_id = :'obj1'),
  1,
  'обращение без указания объекта в его экспозицию не пошло');

-- ---------------------------------------------------------------------------
-- Счётчик не правится снаружи
-- ---------------------------------------------------------------------------
-- Число, которое агент может поправить руками, — это не измерение, а мнение.

-- Агент видит в таблице ровно те строки, объекты которых ему и так видны:
-- политика спрашивает правила видимости объектов, а не повторяет их.
select test.ok(
  (select count(*)::int from object_views) > 0,
  'агент видит счётчики объектов, которые ему видны');

select test.throws(
  'insert into object_views (object_id, day, views) values (''' || :'obj1' || ''', current_date, 999)',
  'permission denied',
  'и не пишет в неё');

set role anon;
select test.throws(
  'select count(*) from object_views',
  'permission denied',
  'аноним не читает счётчики вовсе');
set role postgres;

-- ---------------------------------------------------------------------------
-- Уборка
-- ---------------------------------------------------------------------------
insert into object_views (object_id, day, views)
values (:'obj1', current_date - 500, 3)
on conflict (object_id, day) do update set views = 3;

select test.eq(
  (select count(*)::int from object_views where object_id = :'obj1' and day < current_date - 400),
  1,
  'старая строка есть: уборка ниже проверяется не на пустоте');

select test.eq(app.purge_object_views(), 1, 'уборка убрала ровно одну строку');

select test.eq(
  (select count(*)::int from object_views where object_id = :'obj1' and day < current_date - 400),
  0,
  'старых строк не осталось');

select test.eq(
  (select views_total from object_exposure_v where object_id = :'obj1'),
  25,
  'а свежие счётчики уборка не тронула');

-- Работа зарегистрирована и названа своим обработчиком: без этого планировщик
-- честно скажет «для работы purge_object_views нет кода», и уборка не пойдёт.
select test.eq(
  (select handler::text from maintenance_jobs where job = 'purge_object_views'),
  'app.job_purge_object_views()',
  'уборка зарегистрирована в расписании со своим обработчиком');
