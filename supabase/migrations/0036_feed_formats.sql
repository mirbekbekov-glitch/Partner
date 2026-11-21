-- 0036_feed_formats.sql
-- ИНВАРИАНТ 28, продолжение: у фида есть формат, и он назван.
--
-- Миграция 0035 отдала фид в собственной схеме `partner-feed`. Этого хватает,
-- чтобы отдать интегратору площадки файл и сказать «вот наши данные», но не
-- хватает, чтобы площадка забрала объявления сама: она ждёт свой формат.
--
-- ЧЕГО У НАС НЕТ. Спецификации фида Лалафо. Их сайт закрыт защитой от роботов,
-- в открытом доступе документации нет, а партнёрскую выдают вместе с тарифом.
-- Поэтому написать «адаптер Лалафо» и быть уверенным в именах полей нельзя.
--
-- ЧТО ВМЕСТО ЭТОГО. Формат — это настройка канала, а не выдумка в коде:
--
--   — `partner` — наша схема. Годится, чтобы отдать интегратору;
--   — `yandex_realty` — схема Яндекс.Недвижимости. В СНГ её принимают чаще
--     всего, и если площадка принимает хоть что-то, то скорее её;
--   — `cian` — схема ЦИАН, вторая по распространённости.
--
-- Канал настраивается на формат, экран кабинета этот формат НАЗЫВАЕТ и честно
-- пишет, подтверждён он спецификацией площадки или выбран предположительно.
-- Когда спецификация Лалафо придёт, меняется одна строка в данных — или
-- добавляется модуль формата, если их схема своя.
--
-- ПОЧЕМУ ЭТО НЕ «СДЕЛАТЬ ПОТОМ». Потому что формат меняет не только XML: фид
-- Яндекса обязан содержать телефон для связи, а наш каталог телефонов не
-- содержит вовсе (инвариант 4). Значит каналу нужен контакт агентства — и
-- правило: фид, которому нужен телефон, без телефона не собирается. Молча
-- отдать площадке объявления, по которым нельзя позвонить, хуже, чем не
-- отдать ничего.

create type feed_format as enum ('partner', 'yandex_realty', 'cian');

comment on type feed_format is
  'Схема, в которой отдаётся фид канала. Данные, а не код: спецификацию площадки узнают вместе с тарифом.';

alter table channel_feeds add column format feed_format not null default 'partner';

-- Подтверждена ли схема спецификацией площадки. Пока нет — экран обязан об
-- этом сказать, иначе агентство будет думать, что выгрузка настроена.
alter table channel_feeds add column format_confirmed boolean not null default false;

alter table channel_feeds add column contact_phone text;

comment on column channel_feeds.format is
  'Схема фида. Меняется строкой в данных, а не правкой кода.';
comment on column channel_feeds.format_confirmed is
  'Схему подтвердила площадка (прислала спецификацию или приняла фид). Пока false — это предположение, и экран говорит об этом словами.';
comment on column channel_feeds.contact_phone is
  'Телефон агентства для объявлений на этой площадке. НЕ телефон собственника: его в фиде нет и быть не может (инвариант 4).';

-- Телефон приводится к тому же виду, что везде: площадка получит E.164, а не
-- то, как его записал администратор.
create or replace function app.normalize_feed_contact() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare v text;
begin
  if new.contact_phone is null or btrim(new.contact_phone) = '' then
    new.contact_phone := null;
    return new;
  end if;

  v := app.normalize_phone(new.contact_phone);
  if v is null then
    raise exception 'INVARIANT_28: «%» не похоже на номер телефона', new.contact_phone
      using errcode = 'check_violation';
  end if;

  new.contact_phone := v;
  return new;
end $$;

create trigger a_feed_contact
  before insert or update of contact_phone on channel_feeds
  for each row execute function app.normalize_feed_contact();

-- ---------------------------------------------------------------------------
-- Чего требует формат
-- ---------------------------------------------------------------------------
-- Знание «этому формату нужен телефон» живёт в базе, а не в отправщике:
-- иначе каждый новый клиент фида выяснял бы это заново.

create or replace function app.format_needs_contact(p_format feed_format)
  returns boolean
  language sql immutable set search_path = pg_temp as $$
  select p_format in ('yandex_realty', 'cian')
$$;

comment on function app.format_needs_contact is
  'Формату нужен контакт для связи. Объявление, по которому нельзя позвонить, площадке бесполезно, а нам вредно.';

create or replace function app.feed_settings(p_token text)
  returns table (
    channel          publication_channel,
    format           feed_format,
    format_confirmed boolean,
    contact_phone    text,
    ready            boolean,
    not_ready_reason text
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  select
    f.channel,
    f.format,
    f.format_confirmed,
    f.contact_phone,
    not (app.format_needs_contact(f.format) and f.contact_phone is null) as ready,
    case
      when app.format_needs_contact(f.format) and f.contact_phone is null
        then 'формату ' || f.format::text ||
             ' нужен телефон для связи, а он у канала не задан'
    end as not_ready_reason
  from channel_feeds f
  where f.token = p_token and f.enabled
$$;

comment on function app.feed_settings is
  'Всё, что нужно знать отдающему фид: канал, схема и готов ли канал отдаваться. Неготовый канал отдаёт отказ, а не половинчатый фид.';

-- ---------------------------------------------------------------------------
-- Настройка канала
-- ---------------------------------------------------------------------------

create or replace function set_feed_format(
  p_channel   publication_channel,
  p_format    feed_format,
  p_confirmed boolean default false,
  p_contact   text default null
) returns channel_feeds
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r channel_feeds;
begin
  if not app.is_admin() then
    raise exception 'INVARIANT_28: формат фида настраивает администратор'
      using errcode = '42501';
  end if;

  update channel_feeds
     set format = p_format,
         format_confirmed = p_confirmed,
         contact_phone = coalesce(nullif(btrim(coalesce(p_contact, '')), ''), contact_phone)
   where channel = p_channel
  returning * into r;

  if r.channel is null then
    raise exception 'канала % нет', p_channel using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function set_feed_format is
  'Инвариант 28. Схема фида канала и контакт для неё. Подтверждение схемы ставится руками: его ставит тот, кто видел спецификацию площадки или её ответ.';

-- ---------------------------------------------------------------------------
-- Лалафо: предположение, названное предположением
-- ---------------------------------------------------------------------------
-- Схема Яндекс.Недвижимости выбрана потому, что в СНГ её принимают чаще
-- прочих. Это ДОГАДКА, и format_confirmed = false говорит об этом на экране.
-- Телефон агентства не задаётся здесь: его знает агентство, а не миграция, и
-- без него канал честно считается ненастроенным.

update channel_feeds
   set format = 'yandex_realty', format_confirmed = false,
       note = 'схема выбрана предположительно: спецификацию Лалафо выдают вместе с тарифом'
 where channel = 'lalafo';

update channel_feeds
   set format = 'yandex_realty', format_confirmed = false,
       note = 'схема выбрана предположительно: спецификацию House.kg выдают вместе с тарифом'
 where channel = 'house_kg';

-- ---------------------------------------------------------------------------
-- Что видно в кабинете
-- ---------------------------------------------------------------------------

-- Столбцы добавляются в середину, а `create or replace view` так не умеет.
drop view if exists channel_feeds_v;

create view channel_feeds_v as
select
  f.channel,
  f.enabled,
  f.format,
  f.format_confirmed,
  f.contact_phone,
  not (app.format_needs_contact(f.format) and f.contact_phone is null) as ready,
  f.rotated_at,
  f.created_at,
  f.note,
  (select count(*) from publication_channels pc
    join public_catalog_v c on c.id = pc.object_id
   where pc.channel = f.channel and pc.enabled)::int as objects_in_feed,
  (select max(fe.fetched_at) from channel_fetches fe where fe.channel = f.channel)
    as last_fetched_at,
  (select count(*) from channel_fetches fe
    where fe.channel = f.channel and fe.fetched_at > now() - interval '7 days')::int
    as fetches_week
from channel_feeds f;

comment on view channel_feeds_v is
  'Каналы выгрузки для кабинета. Токен сюда не входит: ссылку показывает отдельная функция администратору.';

grant select on channel_feeds_v to authenticated;
revoke all on channel_feeds_v from anon;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.normalize_feed_contact(),
  app.format_needs_contact(feed_format),
  app.feed_settings(text),
  set_feed_format(publication_channel, feed_format, boolean, text)
  from public;

grant execute on function
  app.format_needs_contact(feed_format),
  set_feed_format(publication_channel, feed_format, boolean, text)
  to authenticated;

-- Отдающему фид теперь нужна одна функция вместо двух: app.feed_settings()
-- возвращает и канал, и схему, и готовность. channel_by_token() остаётся для
-- отладки, но анониму больше не открыт: роль не должна уметь лишнего только
-- потому, что когда-то умела.
grant execute on function app.feed_settings(text) to anon;
revoke execute on function app.channel_by_token(text) from anon;
