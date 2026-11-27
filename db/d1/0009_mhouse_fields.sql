-- Поля для выгрузки на MHouse.
--
-- Площадка не публикует объявление, если нет хотя бы одного обязательного
-- поля. У нас их не было вовсе: координат нет в схеме, серии и типа дома
-- нет, срока аренды нет. Квартиры — основная категория — ушли бы в отказ
-- все до одной, и фид выглядел бы работающим, не давая ни одного
-- объявления.
--
-- Поэтому поля заводятся здесь, а не подставляются в фид константами.
-- Константа в выгрузке — это ложь о чужом объекте: «монолитный» у дома,
-- который панельный, вернётся агенту звонком разочарованного покупателя.
--
-- Все колонки необязательные. Объект без них остаётся как был: он просто
-- не попадёт в выгрузку, и это видно в кабинете, а не выясняется из
-- отчёта площадки.

-- Координаты. Обязательны для ЛЮБОЙ категории.
alter table objects add column latitude  real;
alter table objects add column longitude real;

-- Адрес по справочнику площадки. Регион и населённый пункт она принимает
-- только из своего списка; район и микрорайон — только для Бишкека.
alter table objects add column region         text;
alter table objects add column district       text;
alter table objects add column micro_district text;
alter table objects add column house_number   text;

-- Квартира: тип дома и серия. Без них квартира не публикуется.
alter table objects add column building_type text;
alter table objects add column serie         text;

-- Дом, дача, участок: площадь участка в сотках. Отдельно от area, которая
-- у дома означает площадь дома, а не земли.
alter table objects add column land_area real check (land_area is null or land_area > 0);

-- Аренда: за какой срок сдаётся. Обязательно для любой аренды.
alter table objects add column rental_term text;

-- Коммерческая недвижимость: что именно — офис, склад, магазин.
alter table objects add column commercial_type text;

-- Комната: где она — в квартире, в доме, в общежитии.
alter table objects add column room_location text;

-- Паркинг или гараж: что именно.
alter table objects add column parking_type text;

-- Год постройки. Не обязателен ни в одной категории, но площадка его
-- просит, а агенту он известен ровно тогда же, когда и остальное.
alter table objects add column build_year integer
  check (build_year is null or (build_year between 1800 and 2100));

create index if not exists objects_coords_idx on objects (latitude, longitude)
  where latitude is not null and longitude is not null;
