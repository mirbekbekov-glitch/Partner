-- ИНВАРИАНТ 28. Выгрузка — это каталог, а статус канала — то, что мы знаем.
--
--   а. Фид = публичный каталог, пересечённый с включёнными каналами.
--      Объект, ушедший из каталога, уходит из фида в ту же секунду — без
--      единого каскада, потому что членство не хранится.
--   б. Площадками объекта распоряжается агент его договора.
--   в. Статус не содержит утверждений о чужой площадке.
--   г. Ссылка на фид своя у каждого канала, секретная и поворачиваемая.
--   д. Журнал обращений за фидом дописывается и не переписывается.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- ===========================================================================
-- 28а. Фид это каталог
-- ===========================================================================

select set_channel(:'obj1', 'lalafo', true) is not null as on1 \gset
select test.eq(
  (select count(*) from app.channel_feed('lalafo') f where f.id = :'obj1'),
  1::bigint,
  'включённый канал кладёт опубликованный объект в фид');

select test.eq(
  (select count(*) from app.channel_feed('house_kg') f where f.id = :'obj1'),
  0::bigint,
  'в фид другого канала объект при этом не попадает');

-- Выключенный канал убирает объект из фида, хотя из каталога он никуда не
-- делся: намерение и публикация — разные вещи, и фид есть пересечение.
select set_channel(:'obj1', 'lalafo', false) is not null as off0 \gset
select test.eq(
  (select count(*) from app.channel_feed('lalafo') f where f.id = :'obj1'),
  0::bigint,
  'выключенный канал убирает объект из фида');
select test.eq(
  (select count(*) from public_catalog_v c where c.id = :'obj1'),
  1::bigint,
  'при этом в каталоге объект остался: выключили площадку, а не публикацию');
select set_channel(:'obj1', 'lalafo', true) is not null as on1b \gset

-- Главное свойство: членство НЕ хранится. Снимаем объект с публикации и
-- проверяем фид, ничего больше не трогая.
select withdraw_object(:'obj1') is not null as off1 \gset
select test.eq(
  (select count(*) from app.channel_feed('lalafo') f where f.id = :'obj1'),
  0::bigint,
  'снятый с публикации объект исчез из фида сам, без каскада');

select test.ok(
  (select enabled from publication_channels
    where object_id = :'obj1' and channel = 'lalafo'),
  'намерение отдавать объект на площадку при этом сохранилось');

select publish_object(:'obj1') is not null as on2 \gset
select test.eq(
  (select count(*) from app.channel_feed('lalafo') f where f.id = :'obj1'),
  1::bigint,
  'вернули в каталог — вернулся и в фид, включать площадку заново не нужно');

-- То же самое с договором: мандат кончился — объект ушёл отовсюду.
set role postgres;
set request.jwt.claims = '{}';
update mandates set valid_from = current_date - 30, valid_to = current_date - 1
 where object_id = :'obj1' and status = 'active';
select test.ok(app.expire_mandates() >= 1, 'мандат истёк по расписанию');
select test.eq(
  (select count(*) from app.channel_feed('lalafo') f where f.id = :'obj1'),
  0::bigint,
  'объект без действующего договора в фид не отдаётся');

-- Телефонов в фиде нет не потому, что мы их вырезаем, а потому, что фид
-- строится из public_catalog_v, где их нет вовсе. Проверяется структурно:
-- набор полей фида обязан совпадать с набором полей каталога.
select test.eq(
  (select array_agg(p.proname::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'channel_feed'
      and p.prosrc like '%public_catalog_v%'),
  array['channel_feed'],
  'фид берёт строки из публичного каталога, а не из своего запроса');

select test.ok(
  not exists (
    select 1 from information_schema.columns
     where table_name = 'public_catalog_v' and column_name ilike '%phone%'),
  'в публичном каталоге нет телефонов, значит их нет и в фиде');

-- ===========================================================================
-- 28б. Площадками распоряжается агент договора
-- ===========================================================================
-- Шестой случай, когда «агент» оказывается не «этот агент». До инварианта 28
-- любой одобренный агент мог снять чужой объект со всех площадок, то есть
-- молча выключить чужую рекламу.

-- Агент договора включает площадку своему объекту — и именно её посторонний
-- потом попытается выключить. Без этой строки проверка «читать можно»
-- прошла бы на пустоте.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select set_channel(:'obj2', 'lalafo', true) is not null as on2 \gset

set request.jwt.claims = :'claims_bakyt';

select test.throws(
  format($$select set_channel(%L, 'lalafo', false)$$, :'obj2'),
  'INVARIANT_28',
  'посторонний агент чужой объект с площадки не снимает');

select test.throws(
  format($$insert into publication_channels (object_id, channel, enabled)
           values (%L, 'mini_app', true)$$, :'obj2'),
  'permission denied',
  'и напрямую в таблицу не пишет: прямая запись закрыта правами, а не политикой');

select test.eq(
  test.visible_count(format(
    $$select 1 from publication_channels where object_id = %L$$, :'obj2')),
  1::bigint,
  'читать каналы агентству можно: это не контакт и не комиссия');

-- А listing-агент — может.
set request.jwt.claims = :'claims_aibek';

-- Прямая запись закрыта и тому, кто объект ведёт: дверь одна — set_channel().
select test.throws(
  format($$insert into publication_channels (object_id, channel, enabled)
           values (%L, 'mini_app', true)$$, :'obj2'),
  'permission denied',
  'даже агент договора пишет не в таблицу, а через функцию');

select test.eq(
  (select enabled from set_channel(:'obj2', 'house_kg', true)),
  true,
  'агент договора площадку включает');
select test.eq(
  (select enabled from set_channel(:'obj2', 'house_kg', false)),
  false,
  'и выключает');

set request.jwt.claims = :'claims_admin';
select test.eq(
  (select enabled from set_channel(:'obj2', 'house_kg', true)),
  true,
  'админ тоже');

-- Канал нельзя включить объекту без действующего договора: это проверка
-- намерения, а не членства (инвариант 1 на входе). Дотянуться до неё может
-- только админ: у объекта без договора нет listing-агента, и всех остальных
-- раньше останавливает инвариант 28.
set request.jwt.claims = :'claims_admin';
select test.throws(
  format($$select set_channel(%L, 'mini_app', true)$$, :'obj1'),
  'INVARIANT_1',
  'площадку объекту без договора не включить даже администратору');

-- ===========================================================================
-- 28в. Никаких утверждений о чужой площадке
-- ===========================================================================
-- `exported` и `updated` были словами, которые система говорила о чужой
-- системе, ничего о ней не зная. Их больше нет — вместе с типом.

set role postgres;
set request.jwt.claims = '{}';
select test.eq(
  (select count(*)::int from pg_type where typname = 'channel_status'),
  0,
  'типа channel_status больше нет: системе нечего утверждать о площадке');

select test.ok(
  not exists (select 1 from information_schema.columns
               where table_name = 'publication_channels' and column_name = 'status'),
  'и столбца status тоже');

-- Состояние «включено, но объекта нет в каталоге» существует и названо.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select state from channel_state_v
    where object_id = :'obj1' and channel = 'lalafo'),
  'включено, но объекта нет в каталоге',
  'экран говорит правду о расхождении намерения и каталога');

-- ===========================================================================
-- 28г. Ссылка на фид
-- ===========================================================================

select test.throws(
  $$select feed_url('lalafo')$$,
  'INVARIANT_28',
  'агенту ссылка на фид не показывается: по ней отдаётся весь каталог канала');

-- Токены закрыты не политикой, а правами: агенту отказывают раньше, чем
-- дело доходит до строк. Это сильнее, чем «видно ноль строк».
select test.throws(
  $$select count(*) from channel_feeds$$,
  'permission denied',
  'и сама таблица с токенами агенту не открыта вовсе');

set request.jwt.claims = :'claims_admin';
select feed_url('lalafo') as url1 \gset
select test.ok(:'url1' like '/feed/%.xml', 'админ получает ссылку на фид');

-- Разрешение токена — дело маршрута фида, и открыто оно только роли anon:
-- агенту знать чужие токены незачем. Поэтому проверяется из-под владельца.
set role postgres;
select token as tok1 from channel_feeds where channel = 'lalafo' \gset
select test.eq(app.channel_by_token(:'tok1'), 'lalafo'::publication_channel,
  'по токену находится его канал');
set role authenticated;

-- Поворот отзывает старую ссылку сразу: утёкшую ссылку отзывают, а не просят
-- ею не пользоваться.
select app.rotate_feed_token('lalafo') as tok2 \gset
select test.ok(:'tok2' <> :'tok1', 'поворот выдал другой токен');
set role postgres;
select test.ok(app.channel_by_token(:'tok1') is null,
  'старая ссылка перестала работать в ту же секунду');
select test.eq(app.channel_by_token(:'tok2'), 'lalafo'::publication_channel,
  'новая работает');
set role authenticated;

set request.jwt.claims = :'claims_aibek';
select test.throws(
  $$select app.rotate_feed_token('lalafo')$$,
  'INVARIANT_28',
  'агент ссылку не поворачивает');

-- Выключенный канал не отдаёт фид вовсе.
set role postgres;
set request.jwt.claims = '{}';
update channel_feeds set enabled = false where channel = 'lalafo';
select test.ok(app.channel_by_token(:'tok2') is null,
  'выключенный канал по своему токену не отзывается');
update channel_feeds set enabled = true where channel = 'lalafo';

-- ===========================================================================
-- 28д. Журнал обращений за фидом
-- ===========================================================================
-- Единственное доказательство, что выгрузка работает. Без него «мы отдаём»
-- ничем не отличается от «мы думаем, что отдаём».

select app.record_channel_fetch('lalafo', 18, 4096);
select test.eq(
  (select count(*) from channel_fetches where channel = 'lalafo'),
  1::bigint,
  'обращение за фидом записано');

select test.throws(
  $$update channel_fetches set items = 999$$,
  'не переписывается',
  'журнал обращений не переписывается');

select test.throws(
  $$delete from channel_fetches$$,
  'не переписывается',
  'и не чистится');

select test.ok(
  (select last_fetched_at from channel_feeds_v where channel = 'lalafo') is not null,
  'экран каналов показывает, когда фид забирали');

-- Запись говорит ровно то, что знает: фид забрали. Не «разместили».
select test.ok(
  not exists (select 1 from information_schema.columns
               where table_name = 'channel_fetches'
                 and column_name in ('published', 'placed', 'status')),
  'в журнале обращений нет поля, которым можно было бы соврать о размещении');

-- ===========================================================================
-- 28е. У фида есть формат, и он назван
-- ===========================================================================
-- Спецификации фида Лалафо у нас нет: сайт закрыт защитой от роботов, в
-- открытом доступе документации нет, партнёрскую выдают вместе с тарифом.
-- Поэтому формат — настройка канала, а не выдумка в коде, и «не подтверждён
-- площадкой» обязано быть видно, иначе агентство решит, что выгрузка
-- настроена.

set role authenticated;
set request.jwt.claims = :'claims_admin';

select test.eq(
  (select format from channel_feeds_v where channel = 'lalafo'),
  'yandex_realty'::feed_format,
  'для Лалафо выбрана схема Яндекс.Недвижимости');

select test.ok(
  not (select format_confirmed from channel_feeds_v where channel = 'lalafo'),
  'и она НЕ подтверждена: это догадка, пока площадка не прислала спецификацию');

-- Схеме Яндекса нужен телефон для связи, и без него канал не готов. Молча
-- отдать площадке объявления, по которым нельзя позвонить, хуже, чем не
-- отдать ничего.
select test.ok(
  app.format_needs_contact('yandex_realty'),
  'схеме Яндекса нужен контакт');
select test.ok(
  not app.format_needs_contact('partner'),
  'нашей собственной схеме — нет: её отдают интегратору, а не публикуют');

select test.ok(
  not (select ready from channel_feeds_v where channel = 'lalafo'),
  'без телефона канал не готов отдавать фид');

select set_feed_format('lalafo', 'yandex_realty', false, '0312 900 900') is not null as cfg \gset
select test.eq(
  (select contact_phone from channel_feeds_v where channel = 'lalafo'),
  '+996312900900',
  'телефон канала нормализован так же, как везде');
select test.ok(
  (select ready from channel_feeds_v where channel = 'lalafo'),
  'с телефоном канал готов');

-- Это телефон АГЕНТСТВА, а не собственника: телефонов собственников в фиде
-- нет и быть не может, их нет в публичном каталоге (инвариант 4).
select test.ok(
  not exists (
    select 1 from contact_phones cp
     where cp.phone = (select contact_phone from channel_feeds_v where channel = 'lalafo')),
  'контакт канала не совпадает ни с одним телефоном контакта из базы');

select test.throws(
  $$select set_feed_format('lalafo', 'yandex_realty', false, 'не телефон')$$,
  'не похоже на номер телефона',
  'мусор вместо телефона канала отклонён');

-- Настройка формата — дело администратора: от неё зависит, что увидит
-- площадка и по какому номеру к ней придут.
set request.jwt.claims = :'claims_aibek';
select test.throws(
  $$select set_feed_format('lalafo', 'partner', true)$$,
  'INVARIANT_28',
  'агент формат фида не настраивает');

-- Настройки отдаются по токену одним запросом: отдающему фид нужно знать не
-- только канал, но и готов ли он.
set role postgres;
set request.jwt.claims = '{}';
select token as ftok from channel_feeds where channel = 'lalafo' \gset
select test.eq(
  (select format from app.feed_settings(:'ftok')),
  'yandex_realty'::feed_format,
  'настройки канала находятся по токену');
select test.ok(
  (select ready from app.feed_settings(:'ftok')),
  'и говорят, что канал готов');

update channel_feeds set contact_phone = null where channel = 'lalafo';
select test.ok(
  not (select ready from app.feed_settings(:'ftok')),
  'без контакта настройки говорят, что канал НЕ готов');
select test.ok(
  (select not_ready_reason from app.feed_settings(:'ftok')) like '%телефон%',
  'и говорят, чего не хватает, словами');
