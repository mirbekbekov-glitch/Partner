-- 0035_channel_feeds.sql
-- ИНВАРИАНТ 28: выгрузка — это каталог, а статус канала — то, что мы знаем.
--
-- До этой миграции выгрузка на площадки была нарисована, а не сделана.
-- publication_channels хранила статусы `exported` и `updated`, отчёт
-- собственнику показывал «Lalafo — размещено, House.kg — обновлено», и всё
-- это были засеянные данные: наружу не уходило ничего. Строка в отчёте
-- утверждала то, чего система не знала и знать не могла.
--
-- ТРИ ВЕЩИ, КОТОРЫЕ ЗДЕСЬ ИСПРАВЛЯЮТСЯ.
--
-- 1. ЧЛЕНСТВО В ФИДЕ НЕ ХРАНИТСЯ, А СЧИТАЕТСЯ. Объект в выгрузке тогда и
--    только тогда, когда он в публичном каталоге и канал для него включён.
--    Хранить «выгружен» отдельно от «опубликован» значит завести вторую
--    правду, которая однажды разойдётся с первой: мандат истёк, объект ушёл
--    из каталога, а на площадке висит квартира, на которую у агентства нет
--    договора. Ровно это платформа обещает не делать.
--
--    Из-за хранения membership существовали каскады: снятие мандата
--    переписывало статусы каналов, withdraw_object() переписывал их же.
--    Теперь они не нужны — их здесь и убирают. Половина каскадов в системе
--    существует только потому, что что-то хранится дважды.
--
-- 2. СТАТУС ГОВОРИТ О ТОМ, ЧТО МЫ ЗНАЕМ. Площадка не сообщает нам, что она
--    разместила объект. Мы знаем: канал включён агентом; фид по его ссылке
--    запрашивали; формирование фида упало с ошибкой. Всё. Поэтому `exported`
--    и `updated` уходят вместе с типом channel_status, а остаётся намерение
--    (`enabled`) и наблюдения (журнал обращений за фидом).
--
--    Даже «площадка забрала фид» — осторожная формулировка: мы видим, что
--    по ссылке пришли. Ссылка у каждого канала своя и секретная, поэтому
--    «пришли по ссылке лалафо» это лучшее доказательство, какое бывает без
--    их API, — но это всё ещё не «разместили».
--
-- 3. КАНАЛОМ РАСПОРЯЖАЕТСЯ ТОТ, КТО ВЕДЁТ ОБЪЕКТ. Шестой случай, когда
--    «агент» оказывается не «этот агент»: политика channels_write пускала
--    любого одобренного агента, и он мог снять чужой объект со всех
--    площадок — то есть молча выключить чужую рекламу:
--
--      set request.jwt.claims = '{"sub":"...посторонний..."}';
--      update publication_channels set status = 'withdrawn'
--       where object_id = '<чужой объект>';   -- UPDATE 1
--
--    Теперь правило то же, что в инварианте 22: объектом распоряжается
--    listing-агент действующего договора или администратор.

-- ---------------------------------------------------------------------------
-- Намерение вместо претензии
-- ---------------------------------------------------------------------------

alter table publication_channels add column enabled boolean not null default true;

update publication_channels
   set enabled = (status <> 'withdrawn');

comment on column publication_channels.enabled is
  'Инвариант 28. Намерение агента отдавать этот объект в этот канал. Членство в фиде отсюда НЕ следует: оно считается вместе с каталогом.';

-- Каскады, существовавшие ради хранимого членства, переписываются до того,
-- как столбец status исчезнет.

create or replace function app.withdraw_on_mandate_release() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_object uuid := coalesce(old.object_id, new.object_id);
begin
  if tg_op = 'DELETE' or (old.status = 'active' and new.status <> 'active') then
    if app.active_mandate_id(v_object) is null then
      update objects
         set publication_state = 'withdrawn'
       where id = v_object
         and publication_state = 'published';

      -- Каналы здесь больше не трогаются. Объект ушёл из каталога — значит
      -- ушёл из фида: членство считается, а не хранится (инвариант 28).
      -- Намерение агента «отдавать на лалафо» при этом сохраняется и снова
      -- начнёт работать, когда договор продлят. Это не недосмотр: продление
      -- договора не должно требовать заново включать площадки.
    end if;
  end if;
  return null;
end $$;

comment on function app.withdraw_on_mandate_release is
  'Инвариант 1. Снятие мандата снимает объект с публикации. Каналы не трогает: из фида объект уходит вместе с каталогом (инвариант 28).';

create or replace function app.check_channel_publication() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Включить канал можно только объекту с действующим договором. Это
  -- проверка намерения, а не членства: держать включённым канал объекта,
  -- у которого договор истёк, не вредно — в фид он всё равно не попадёт, —
  -- но ВКЛЮЧАТЬ его в таком состоянии бессмысленно и запутывает.
  if new.enabled and app.active_mandate_id(new.object_id) is null then
    raise exception
      'INVARIANT_1: объект % не может быть выгружен в канал % без активного мандата',
      new.object_id, new.channel
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists c_channels_require_mandate on publication_channels;
create trigger c_channels_require_mandate
  before insert or update of enabled on publication_channels
  for each row execute function app.check_channel_publication();

-- ---------------------------------------------------------------------------
-- Инвариант 28: каналом распоряжается тот, кто ведёт объект
-- ---------------------------------------------------------------------------

create or replace function app.can_manage_channel(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select app.is_admin() or app.is_listing_agent(p_object_id)
$$;

comment on function app.can_manage_channel is
  'Инвариант 28. Площадками объекта распоряжается listing-агент действующего договора или админ — то же правило, что у правки объекта (инвариант 22).';

create or replace function app.check_channel_editor() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_object uuid := coalesce(new.object_id, old.object_id);
begin
  -- Без вошедшего агента каналы трогают миграции, засев и обслуживание.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if not app.can_manage_channel(v_object) then
    raise exception
      'INVARIANT_28: площадками объекта распоряжается агент его договора'
      using errcode = '42501',
            hint = 'Снять чужой объект с площадки — это выключить чужую рекламу.';
  end if;

  return coalesce(new, old);
end $$;

create trigger b_channel_editor
  before insert or update or delete on publication_channels
  for each row execute function app.check_channel_editor();

-- Политика «любой вошедший пишет» была той самой дырой. Убирается она не
-- заменой на более строгую политику, а тем же способом, что в инварианте 19:
-- прямая запись в таблицу закрывается правами, и остаётся единственный путь —
-- функция set_channel(). Тогда у двух защит разные задачи, и каждую видно по
-- отдельности: права не дают писать в таблицу руками, триггер не даёт ни
-- одной функции обойти правило. Две политики, проверяющие одно и то же,
-- выглядят надёжнее, а на деле лишь прячут друг друга — вторая никогда не
-- срабатывает, и сломать её можно незаметно.
drop policy if exists channels_write on publication_channels;
revoke insert, update, delete on publication_channels from authenticated;

comment on table publication_channels is
  'Инвариант 28. Намерение отдавать объект в канал. Пишется только через set_channel(): прямая запись закрыта правами.';

-- ---------------------------------------------------------------------------
-- Ссылка на фид у каждого канала своя
-- ---------------------------------------------------------------------------
-- Площадка забирает фид по ссылке. Ссылка секретная и у каждого канала своя
-- — не ради тайны самого каталога, он и так публичный, а ради того, чтобы
-- «фид забрали» можно было отнести к конкретной площадке. Без этого запись
-- в журнале означала бы «кто-то когда-то зашёл».

create table channel_feeds (
  -- uuid, как у maintenance_jobs и по той же причине: журнал инварианта 7
  -- хранит entity_id одним типом, и таблица с ключом-перечислением в него
  -- не поместилась бы. Канал при этом остаётся ключом по смыслу.
  id          uuid        primary key default gen_random_uuid(),
  channel     publication_channel not null unique,
  token       text        not null unique check (length(token) >= 24),
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  note        text
);

comment on table channel_feeds is
  'Инвариант 28. Ссылка, по которой площадка забирает фид. Своя на канал, чтобы обращение за фидом можно было отнести к площадке.';

create trigger zz_audit_channel_feeds
  after insert or update or delete on channel_feeds
  for each row execute function app.write_audit('channel_feed', 'id');

alter table channel_feeds enable row level security;

-- Токен это ключ доступа к фиду. Агенту он незачем, админу нужен.
create policy channel_feeds_admin on channel_feeds for all
  using (app.is_admin()) with check (app.is_admin());

create or replace function app.new_feed_token() returns text
  language sql volatile set search_path = public, extensions, pg_temp as $$
  select replace(gen_random_uuid()::text, '-', '') ||
         replace(gen_random_uuid()::text, '-', '')
$$;

insert into channel_feeds (channel, token, note)
select c, app.new_feed_token(),
       'создан миграцией 0035; выдайте площадке и при утечке поверните'
  from unnest(enum_range(null::publication_channel)) as c
 where c <> 'site';

comment on column channel_feeds.token is
  'Секрет в адресе фида. Площадке выдаётся один раз; при утечке поворачивается через app.rotate_feed_token().';

create or replace function app.rotate_feed_token(p_channel publication_channel)
  returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token text;
begin
  if not app.is_admin() then
    raise exception 'INVARIANT_28: ссылку фида поворачивает администратор'
      using errcode = '42501';
  end if;

  update channel_feeds
     set token = app.new_feed_token(), rotated_at = now()
   where channel = p_channel
  returning token into v_token;

  if v_token is null then
    raise exception 'канала % нет', p_channel using errcode = 'no_data_found';
  end if;
  return v_token;
end $$;

comment on function app.rotate_feed_token is
  'Новая ссылка на фид. Старая перестаёт работать сразу: утёкшую ссылку отзывают, а не просят не пользоваться.';

-- ---------------------------------------------------------------------------
-- Журнал обращений за фидом
-- ---------------------------------------------------------------------------
-- Единственное доказательство, что выгрузка работает. Без него «мы отдаём»
-- ничем не отличается от «мы думаем, что отдаём». Дописывается и не
-- переписывается — как журнал запусков обслуживания (инвариант 16).

create table channel_fetches (
  id         uuid primary key default gen_random_uuid(),
  channel    publication_channel not null references channel_feeds (channel) on delete cascade,
  fetched_at timestamptz not null default now(),
  items      integer     not null check (items >= 0),
  bytes      integer     not null check (bytes >= 0)
);

create index channel_fetches_idx on channel_fetches (channel, fetched_at desc);

comment on table channel_fetches is
  'Инвариант 28. Кто-то пришёл по секретной ссылке канала и забрал фид. Это факт; «площадка разместила объект» фактом не является и здесь не хранится.';

create or replace function app.channel_fetches_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'INVARIANT_28: журнал обращений за фидом не переписывается'
    using errcode = 'check_violation';
end $$;

create trigger z_channel_fetches_append_only
  before update or delete on channel_fetches
  for each row execute function app.channel_fetches_append_only();

alter table channel_fetches enable row level security;
create policy channel_fetches_read on channel_fetches for select
  using (app.current_agent_id() is not null);

-- ---------------------------------------------------------------------------
-- Сам фид
-- ---------------------------------------------------------------------------
-- Содержимое — публичный каталог, один в один. Не «похожий запрос», а он
-- самый: объект, пропавший из каталога, обязан пропасть из фида в ту же
-- секунду, и единственный способ это гарантировать — не иметь второго
-- запроса, который можно забыть поправить.

create or replace function app.channel_feed(p_channel publication_channel)
  returns table (
    id           uuid,
    kind         object_kind,
    deal_type    deal_type,
    address      text,
    zone         text,
    rooms        smallint,
    area         numeric,
    floor        smallint,
    floors_total smallint,
    price        numeric,
    currency     char(3),
    photos       text[],
    description  text,
    published_at timestamptz,
    actual_at    timestamptz
  )
  language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.kind, c.deal_type, c.address, c.zone, c.rooms, c.area,
         c.floor, c.floors_total, c.price, c.currency, c.photos, c.description,
         c.published_at, c.actual_at
    from public_catalog_v c
    join publication_channels pc
      on pc.object_id = c.id and pc.channel = p_channel and pc.enabled
   order by c.actual_at desc
$$;

comment on function app.channel_feed is
  'Инвариант 28. Фид канала = публичный каталог, пересечённый с включёнными каналами. Телефонов собственников здесь нет и быть не может: их нет в public_catalog_v.';

create or replace function app.channel_by_token(p_token text)
  returns publication_channel
  language sql stable security definer set search_path = public, pg_temp as $$
  select f.channel from channel_feeds f
   where f.token = p_token and f.enabled
$$;

create or replace function app.record_channel_fetch(
  p_channel publication_channel,
  p_items   integer,
  p_bytes   integer
) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  insert into channel_fetches (channel, items, bytes)
  values (p_channel, greatest(p_items, 0), greatest(p_bytes, 0))
$$;

-- ---------------------------------------------------------------------------
-- Что видно агенту
-- ---------------------------------------------------------------------------

create or replace view channel_state_v
  with (security_invoker = true) as
select
  pc.object_id,
  o.address,
  pc.channel,
  pc.enabled,
  -- Объект сейчас в каталоге? Если нет — в фид он не попадает, чего бы ни
  -- хотел агент, и экран обязан показывать именно это.
  exists (select 1 from public_catalog_v c where c.id = pc.object_id) as in_catalog,
  case
    when not pc.enabled then 'не отдаём'
    when not exists (select 1 from public_catalog_v c where c.id = pc.object_id)
      then 'включено, но объекта нет в каталоге'
    else 'в фиде'
  end as state,
  pc.last_error,
  (select max(f.fetched_at) from channel_fetches f where f.channel = pc.channel)
    as channel_fetched_at
from publication_channels pc
join objects o on o.id = pc.object_id;

comment on view channel_state_v is
  'Инвариант 28. Состояние объекта по каналам. «В фиде» значит «мы отдаём», а не «площадка разместила» — последнего мы не знаем.';

-- Вид НЕ security_invoker, и это сознательно: он читает channel_feeds, где
-- лежат токены, а прав на эту таблицу у агента нет и быть не должно. Сам вид
-- токена не отдаёт — только сколько объектов в фиде и когда за ним приходили.
-- Это не секрет, и агенту полезно: «отдаём» без «забирают» значит, что
-- площадка не настроена.
create or replace view channel_feeds_v as
select
  f.channel,
  f.enabled,
  f.rotated_at,
  f.created_at,
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

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function set_channel(
  p_object_id uuid,
  p_channel   publication_channel,
  p_enabled   boolean
) returns publication_channels
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r publication_channels;
begin
  perform app.require_agent();

  insert into publication_channels (object_id, channel, enabled)
  values (p_object_id, p_channel, p_enabled)
  on conflict (object_id, channel) do update
     set enabled = excluded.enabled, last_error = null
  returning * into r;

  return r;
end $$;

comment on function set_channel is
  'Инвариант 28. Включить или выключить площадку для объекта. Кому это можно — решает триггер b_channel_editor.';

create or replace function feed_url(p_channel publication_channel) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_token text;
begin
  if not app.is_admin() then
    raise exception 'INVARIANT_28: ссылку фида видит администратор'
      using errcode = '42501',
            hint = 'По этой ссылке отдаётся весь каталог канала.';
  end if;

  select token into v_token from channel_feeds where channel = p_channel;
  if v_token is null then
    raise exception 'канала % нет', p_channel using errcode = 'no_data_found';
  end if;
  return '/feed/' || v_token || '.xml';
end $$;

-- ---------------------------------------------------------------------------
-- Снятие объекта: каналы больше не переписываются
-- ---------------------------------------------------------------------------
-- withdraw_object() гасил статусы каналов вручную. Это был тот же второй
-- экземпляр правды: объект уходил из каталога И отдельно помечался снятым в
-- каждом канале. Теперь достаточно первого — из фида он уходит вместе с
-- каталогом. Намерение агента отдавать объект на площадку при этом
-- сохраняется: снял с публикации на неделю, вернул — площадки прежние.

create or replace function withdraw_object(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_22: снимает объект агент действующего договора'
      using errcode = '42501';
  end if;

  update objects set publication_state = 'withdrawn'
   where id = p_object_id returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  return r;
end $$;

comment on function withdraw_object is
  'Инвариант 22. Снимает объект с публикации. Каналы не трогает: из фида объект уходит вместе с каталогом (инвариант 28).';

-- ---------------------------------------------------------------------------
-- Старый статус уходит
-- ---------------------------------------------------------------------------
-- Вместе с ним уходят `exported` и `updated` — два слова, которые система
-- говорила о чужой площадке, ничего о ней не зная.

drop index if exists publication_channels_stale_idx;
alter table publication_channels drop column status;
drop type if exists channel_status;

create index publication_channels_feed_idx
  on publication_channels (channel) where enabled;

-- ---------------------------------------------------------------------------
-- Отчёт собственнику перестаёт утверждать лишнее
-- ---------------------------------------------------------------------------
-- Это та самая строка, которую собственник читал как «ваша квартира
-- размещена на Лалафо». Система этого не знала. Теперь она говорит то, что
-- знает: отдаём ли мы объект в этот канал и когда оттуда приходили за фидом.

create or replace function app.owner_report(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a      owner_access%rowtype;
  o      objects%rowtype;
  v_out  jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;

  select * into a from owner_access where token = p_token;
  if not found
     or a.revoked_at is not null
     or (a.expires_at is not null and a.expires_at < now()) then
    return null;
  end if;

  select * into o from objects where id = a.object_id;
  if not found then
    return null;
  end if;

  -- Просмотр считается здесь: агенту важно знать, дошла ли ссылка.
  update owner_access
     set view_count = view_count + 1, last_viewed_at = now()
   where id = a.id;

  select jsonb_build_object(
    'object', jsonb_build_object(
      'address',           o.address,
      'zone',              o.zone,
      'kind',              o.kind,
      'deal_type',         o.deal_type,
      'rooms',             o.rooms,
      'area',              o.area,
      'floor',             o.floor,
      'floors_total',      o.floors_total,
      'price',             o.price,
      'currency',          o.currency,
      'publication_state', o.publication_state,
      'published_at',      o.published_at,
      'actual_at',         o.actual_at
    ),
    -- ЧЕСТНЫЙ БЛОК КАНАЛОВ (инвариант 28). Раньше здесь стояло «размещено»
    -- и «обновлено» — слова о чужой площадке, которых система не знала. Мы
    -- знаем ровно две вещи: отдаём ли мы объект в этот канал прямо сейчас и
    -- когда по ссылке канала последний раз приходили за фидом.
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel',   pc.channel,
               'in_feed',   pc.enabled and exists (
                              select 1 from public_catalog_v c where c.id = o.id),
               'fetched_at', (select max(f.fetched_at) from channel_fetches f
                               where f.channel = pc.channel),
               'has_error', pc.last_error is not null)
             order by pc.channel)
        from publication_channels pc where pc.object_id = o.id
    ), '[]'::jsonb),
    'showings', (
      select jsonb_build_object(
        'scheduled', count(*) filter (where s.status = 'scheduled'),
        'done',      count(*) filter (where s.status = 'done'),
        'cancelled', count(*) filter (where s.status = 'cancelled'),
        -- Неявка перестаёт складываться с отменой: отменил агент или не
        -- приехал клиент — собственнику это разные новости (инвариант 25).
        'no_show',   count(*) filter (where s.status = 'no_show'),
        'last_done_at', max(s.done_at) filter (where s.status = 'done'),
        -- Только структурная реакция: свободный текст с показа собственнику
        -- не отдаётся, там чужие слова и чужие контакты.
        'outcomes', coalesce(jsonb_object_agg(s.outcome, s.cnt)
                     filter (where s.outcome is not null), '{}'::jsonb))
      from (
        select sh.status, sh.outcome, sh.done_at, count(*) over (
                 partition by sh.outcome) as cnt
          from showings sh
          join matches mt on mt.id = sh.match_id
         where mt.object_id = o.id
      ) s
    ),
    'interest', jsonb_build_object(
      'matches', (select count(*) from matches mt where mt.object_id = o.id),
      'rejected', (select count(*) from matches mt
                    where mt.object_id = o.id and mt.status = 'rejected')
    ),
    -- История цены берётся из журнала (инвариант 7): отдельной таблицы
    -- для неё нет и не нужно. Считаются только правки: у вставки в diff
    -- попадает вся строка, и создание объекта засчиталось бы как изменение
    -- цены, которого не было.
    'price_changes', (
      select jsonb_build_object(
        'count', count(*),
        'last_at', max(al.at))
        from audit_log al
       where al.entity_type = 'object' and al.entity_id = o.id
         and al.action = 'update'
         and al.diff ? 'price'
    ),
    'report', jsonb_build_object(
      'generated_at', now(),
      'views',        a.view_count + 1
    )
  ) into v_out;

  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.can_manage_channel(uuid),
  app.check_channel_editor(),
  app.channel_fetches_append_only(),
  app.new_feed_token(),
  app.rotate_feed_token(publication_channel),
  app.channel_feed(publication_channel),
  app.channel_by_token(text),
  app.record_channel_fetch(publication_channel, integer, integer),
  set_channel(uuid, publication_channel, boolean),
  feed_url(publication_channel)
  from public;

grant execute on function
  app.can_manage_channel(uuid),
  app.rotate_feed_token(publication_channel),
  -- Агенту нужно видеть, что именно уходит на площадку: иначе «отдаём»
  -- остаётся словом. Токен при этом ему не нужен и не выдан.
  app.channel_feed(publication_channel),
  set_channel(uuid, publication_channel, boolean),
  feed_url(publication_channel)
  to authenticated;

-- Фид отдаётся анониму: по ту сторону площадка, а не вошедший агент.
-- Роль при этом не получает ни таблиц, ни каталога сверх того, что уже
-- открыто публично, — только две функции.
grant execute on function
  app.channel_feed(publication_channel),
  app.channel_by_token(text),
  app.record_channel_fetch(publication_channel, integer, integer)
  to anon;

grant select on channel_state_v, channel_feeds_v to authenticated;
grant select on channel_fetches to authenticated;
revoke all on channel_feeds from authenticated, anon;
revoke all on channel_state_v, channel_feeds_v, channel_fetches from anon;
