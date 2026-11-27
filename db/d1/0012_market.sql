-- Индекс рынка: чужие объявления, по которым считается оценка.
--
-- ЗАЧЕМ ОТДЕЛЬНЫЕ ТАБЛИЦЫ, А НЕ objects. Объект в objects — это наша
-- работа: у него есть мандат, собственник, комиссия и агент, который за
-- него отвечает. Объявление с чужой площадки — это НАБЛЮДЕНИЕ за рынком:
-- оно никому не принадлежит, завтра может исчезнуть, и его цену никто не
-- подтверждал. Сложить их в одну таблицу значило бы однажды опубликовать
-- чужое объявление как своё или посчитать по нему комиссию.
--
-- Ровно поэтому здесь нет ни одной колонки, связанной с публикацией,
-- мандатом или агентом: этим строкам нечего делать в кабинете как
-- объектам.
--
-- ЦЕНЫ: ХОТЯ БЫ ОДНА ВАЛЮТА, НО НЕ ОБЯЗАТЕЛЬНО ОБЕ. У продажи площадка
-- пишет сом и доллар рядом, и пара нужна не для удобства: по отношению
-- валют разбор отличает цену от платежа по ипотеке в той же карточке.
-- А у АРЕНДЫ второй валюты почти никогда нет — «63 000 ⃀ / мес», и всё.
-- Требование пары выбрасывало аренду целиком, пока разбор не прогнали по
-- живой странице. Подробности — в lib/market/house-kg.ts.
--
-- СРОК У АРЕНДЫ ОБЯЗАТЕЛЕН. В одной выдаче лежат «63 000 в месяц» и
-- «2 200 в сутки»: это разные рынки, и смешать их в одной медиане значит
-- получить число, которого на рынке нет. Объявление аренды без срока до
-- базы не доходит — назначать ему месяц «по умолчанию» нельзя.
--
-- Минорные единицы — как во всей базе (lib/db/money.ts): REAL для денег
-- не годится, а медиана и проценты считаются именно по этим числам.

create table if not exists market_listings (
  id          text primary key,

  -- Площадка и её идентификатор объявления. Пара уникальна: одно и то же
  -- объявление не должно задвоиться от повторного прогона.
  source      text not null check (source in ('house.kg')),
  source_id   text not null,
  url         text not null,

  deal_type   text not null check (deal_type in ('rent', 'sale')),
  kind        text not null check (kind in
                ('flat', 'room', 'house', 'townhouse', 'land',
                 'commercial', 'garage')),

  city        text not null,
  address     text,
  rooms        integer check (rooms is null or rooms >= 0),
  area         real    check (area is null or area > 0),
  floor        integer,
  floors_total integer,

  price_usd_minor integer check (price_usd_minor is null or price_usd_minor > 0),
  price_kgs_minor integer check (price_kgs_minor is null or price_kgs_minor > 0),

  -- Срок, за который названа цена. У продажи null, у аренды обязателен.
  rent_period text check (rent_period in ('month', 'day')),

  -- КТО ПРОДАЁТ. Три значения, и 'unknown' — не заглушка, а честный
  -- ответ. Проверено на живой странице: у объявления стоит бейдж
  -- «Собственник» И подпись «От Avangard style» одновременно, то есть
  -- бейдж площадки сам по себе собственника НЕ доказывает. Поэтому
  -- 'owner' ставится, только когда бейдж есть, а подписи агентства нет.
  seller_kind text not null default 'unknown'
                   check (seller_kind in ('owner', 'agency', 'unknown')),
  seller_name text,

  -- Сигналы актуальности — те же, что у площадки в её методике: сколько
  -- смотрели, сколько сохранили, поднимали ли объявление и когда оно в
  -- последний раз обновлялось.
  views     integer check (views is null or views >= 0),
  favorites integer check (favorites is null or favorites >= 0),
  bumped    integer not null default 0 check (bumped in (0, 1)),
  -- Что написано на карточке словами («4 часа назад»), и это же время
  -- числом. Текст хранится рядом с разобранным временем нарочно: когда
  -- разбор ошибётся, видно будет, на чём именно.
  bumped_text text,
  bumped_at   text,

  -- Собственная метка площадки: «Выше рынка на 74.27%», «Справедливая
  -- цена». Чужая оценка, не наша: держим её, чтобы свою оценку было с
  -- чем сверять.
  market_note text,

  -- Адрес в виде, пригодном для поиска: тот же приём и та же функция, что
  -- у объектов (lib/db/normalize.ts), иначе «Чүй» не найдётся по «чуй».
  search_text text not null default '',

  -- Когда увидели впервые и в последний раз. Разница между ними — это
  -- «висит давно», главный сигнал готовности продавца к разговору.
  first_seen_at text not null,
  last_seen_at  text not null,
  -- Проставляется, когда объявление перестало попадаться в выдаче.
  -- Строка НЕ УДАЛЯЕТСЯ: исчезнувшее объявление — это факт о рынке
  -- («продали или сняли»), и выбросив его, мы потеряем историю цены.
  gone_at       text,

  -- Табличные проверки стоят ПОСЛЕ всех колонок, и это требование
  -- SQLite, а не вкусовщина: вписанная между колонками, такая строка
  -- роняет создание таблицы с «near "rent_period": syntax error».
  --
  -- Хотя бы одна валюта должна быть названа: строка без цены в выборке
  -- аналогов хуже отсутствующей.
  check (price_usd_minor is not null or price_kgs_minor is not null),
  -- У аренды срок обязателен: месячную и посуточную нельзя смешивать.
  check (deal_type = 'sale' or rent_period is not null),

  unique (source, source_id)
);

-- Выборка аналогов идёт по связке «сделка + тип + город + комнаты», и
-- почти всегда с отсечкой по дате: мёртвые объявления в медиану не идут.
create index if not exists market_listings_segment
  on market_listings (deal_type, kind, city, rooms, rent_period, gone_at);

-- Обход помечает исчезнувшие: «кого не видели в этом прогоне».
create index if not exists market_listings_seen
  on market_listings (source, last_seen_at);

create index if not exists market_listings_search
  on market_listings (search_text);

-- История цены. Строка пишется ТОЛЬКО когда цена отличается от прошлой,
-- иначе ежедневный прогон за год дал бы 365 одинаковых строк на каждое
-- объявление и ни одного факта сверх первой.
--
-- Без этой таблицы нет ни «было $62 999», ни «цена снижалась» — а это
-- главный сигнал того, что продавец готов разговаривать.
create table if not exists market_prices (
  id         text primary key,
  listing_id text not null references market_listings (id) on delete cascade,
  price_usd_minor integer check (price_usd_minor is null or price_usd_minor > 0),
  price_kgs_minor integer check (price_kgs_minor is null or price_kgs_minor > 0),

  -- Срок, за который названа цена. У продажи null, у аренды обязателен.
  rent_period text check (rent_period in ('month', 'day')),
  seen_at    text not null
);

create index if not exists market_prices_listing
  on market_prices (listing_id, seen_at);
