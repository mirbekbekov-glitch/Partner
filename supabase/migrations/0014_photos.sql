-- 0014_photos.sql
-- ИНВАРИАНТ 11: фотография объекта публично доступна ровно тогда, когда
--               объект опубликован.
--
-- До этой миграции фотографии были массивом строк `objects.photos`. Массив
-- не держит ни порядка как данных, ни обложки, ни того, кто и когда загрузил,
-- и главное — ничего не говорит о доступе. Если бы файлы лежали в публичном
-- хранилище по прямым ссылкам, снятие объекта с публикации не делало бы
-- ничего: фотографии остались бы доступны всем, у кого есть ссылка.
--
-- А вся модель построена на том, что публикация — это состояние объекта, а не
-- выгрузка куда-то. Значит и фотографии обязаны следовать состоянию. Поэтому:
--
--   — байты отдаёт приложение, а не хранилище напрямую;
--   — приложению разрешено отдать только то, что лежит в public_photo_v;
--   — public_photo_v показывает фотографии только опубликованных объектов.
--
-- Сняли объект с публикации — ссылка на фотографию перестала работать в тот
-- же момент, без переноса файлов и без чистки кешей хранилища.

create table object_photos (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references objects (id) on delete cascade,

  -- Ключ в хранилище. Форма проверяется здесь, поэтому выход за пределы
  -- каталога объекта невозможен по построению, а не по внимательности
  -- того, кто писал обработчик.
  storage_key text not null unique
    check (storage_key ~ '^objects/[0-9a-f-]{36}/[0-9a-f]{32}\.(jpg|webp|png)$'),

  -- Порядок — это данные, а не случайность выборки. Первая фотография
  -- служит обложкой в каталоге.
  sort_order  integer not null default 0 check (sort_order >= 0),

  content_type text not null
    check (content_type in ('image/jpeg', 'image/webp', 'image/png')),
  width       integer check (width  > 0),
  height      integer check (height > 0),
  byte_size   integer check (byte_size > 0),

  uploaded_by_agent_id uuid not null references agents (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (object_id, sort_order) deferrable initially deferred
);

comment on table object_photos is
  'Инвариант 11. Байты отдаёт приложение по public_photo_v, поэтому доступность фотографии следует публикации объекта.';
comment on column object_photos.sort_order is
  'Порядок показа. Наименьший — обложка в каталоге.';
comment on column object_photos.storage_key is
  'Ключ в хранилище. Форма ограничена проверкой: выход за каталог объекта невозможен по построению.';

create index object_photos_object_idx on object_photos (object_id, sort_order);

-- ---------------------------------------------------------------------------
-- Перенос того, что лежало в массиве
-- ---------------------------------------------------------------------------
-- Старые значения ключами хранилища не являются, поэтому переносить их
-- бессмысленно: это были бы ссылки в никуда. Если массив где-то не пуст,
-- миграция остановится — пусть решает человек, а не догадка.

do $$
declare n integer;
begin
  select count(*) into n from objects where jsonb_array_length(photos) > 0;
  if n > 0 then
    raise exception
      'Миграция 0014: у % объектов непустой objects.photos. Перенесите файлы в хранилище и заполните object_photos вручную.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Инвариант 5 остаётся целым
-- ---------------------------------------------------------------------------
-- Раньше правка фотографий поднимала actual_at, потому что массив лежал в
-- самой строке объекта и триггер 0005 видел изменение. Теперь фотографии в
-- отдельной таблице, и без этого триггера подтверждение актуальности молча
-- перестало бы замечать замену фотографий.

create or replace function app.touch_object_on_photo() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update objects set actual_at = now()
   where id = coalesce(new.object_id, old.object_id);
  return null;
end $$;

create trigger e_photo_touches_object
  after insert or update or delete on object_photos
  for each row execute function app.touch_object_on_photo();

-- Колонка больше не нужна: правда о фотографиях теперь в одном месте.
-- Витрина на неё опирается, поэтому сначала снимается витрина. Заодно это
-- единственный способ сменить тип колонки photos с jsonb на массив ключей:
-- менять тип существующей колонки замена вида не умеет.
drop view public_catalog_v;

alter table objects drop column photos;

-- Триггер 0005 ссылался на снятую колонку, поэтому переписывается целиком.
-- Поведение прежнее, кроме фотографий: их изменение теперь ловит триггер выше.
create or replace function app.object_timestamps() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.publication_state = 'published' and new.published_at is null then
      new.published_at := now();
    end if;
    new.actual_at := coalesce(new.actual_at, now());
    return new;
  end if;

  -- published_at: фиксируется один раз, при первом переходе в published.
  if new.publication_state = 'published' and old.publication_state <> 'published' then
    new.published_at := coalesce(old.published_at, now());
  else
    new.published_at := old.published_at;
  end if;

  -- actual_at: правка цены поднимает актуальность. Правку фотографий ловит
  -- e_photo_touches_object на object_photos.
  if new.price is distinct from old.price then
    new.actual_at := now();
  else
    if new.actual_at is distinct from old.actual_at then
      if new.actual_at < old.actual_at or new.actual_at > now() then
        new.actual_at := old.actual_at;
      end if;
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Журнал (инвариант 7)
-- ---------------------------------------------------------------------------

create trigger a_touch_object_photos
  before update on object_photos
  for each row execute function app.touch_updated_at();

create trigger zz_audit_object_photos
  after insert or update or delete on object_photos
  for each row execute function app.write_audit('photo', 'id');

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------
-- Загружает и удаляет тот, кто отвечает за объект перед собственником:
-- listing-агент действующего мандата. Остальным агентам фотографии видны.

alter table object_photos enable row level security;

create policy object_photos_read on object_photos for select
  using (app.current_agent_id() is not null);

create policy object_photos_write on object_photos for insert
  with check (
    app.is_admin()
    or exists (select 1 from mandates m
                where m.object_id = object_photos.object_id
                  and m.status = 'active'
                  and m.listing_agent_id = app.current_agent_id()));

create policy object_photos_update on object_photos for update
  using (
    app.is_admin()
    or exists (select 1 from mandates m
                where m.object_id = object_photos.object_id
                  and m.status = 'active'
                  and m.listing_agent_id = app.current_agent_id()));

create policy object_photos_delete on object_photos for delete
  using (
    app.is_admin()
    or exists (select 1 from mandates m
                where m.object_id = object_photos.object_id
                  and m.status = 'active'
                  and m.listing_agent_id = app.current_agent_id()));

-- ---------------------------------------------------------------------------
-- Инвариант 11: что видно публично
-- ---------------------------------------------------------------------------
-- Единственное, из чего приложение узнаёт, какой файл можно отдать. Роли anon
-- сама таблица недоступна, поэтому список фотографий неопубликованного
-- объекта ей не достать ни перебором, ни join-ом.

create or replace view public_photo_v as
select
  p.storage_key,
  p.object_id,
  p.sort_order,
  p.content_type,
  p.width,
  p.height
from object_photos p
join objects o on o.id = p.object_id
where o.publication_state = 'published';

comment on view public_photo_v is
  'Инвариант 11. Фотографии опубликованных объектов. Приложение отдаёт байты только по этому списку.';

-- Витрина каталога отдаёт ключи обложки и всех фотографий по порядку.
create view public_catalog_v as
select
  o.id, o.kind, o.deal_type, o.address, o.zone,
  o.rooms, o.area, o.floor, o.floors_total,
  o.price, o.currency,
  coalesce((
    select array_agg(p.storage_key order by p.sort_order, p.created_at)
      from object_photos p where p.object_id = o.id
  ), '{}'::text[]) as photos,
  o.description,
  o.published_at, o.actual_at
from objects o
where o.publication_state = 'published';

comment on view public_catalog_v is
  'Публичная витрина. Комиссия, контакты, мандаты и агенты сюда не попадают.';

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function attach_photo(
  p_object_id    uuid,
  p_storage_key  text,
  p_content_type text,
  p_width        integer default null,
  p_height       integer default null,
  p_byte_size    integer default null
) returns object_photos
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_next  integer;
  r       object_photos;
begin
  if not exists (select 1 from mandates m
                  where m.object_id = p_object_id and m.status = 'active'
                    and (m.listing_agent_id = v_agent or app.is_admin())) then
    raise exception
      'INVARIANT_11: фотографии добавляет listing-агент действующего мандата'
      using errcode = '42501';
  end if;

  -- Порядок выводится на сервере: клиенту его передавать незачем, а гонка
  -- двух загрузок дала бы два одинаковых номера.
  select coalesce(max(sort_order) + 1, 0) into v_next
    from object_photos where object_id = p_object_id;

  insert into object_photos (object_id, storage_key, sort_order, content_type,
                             width, height, byte_size, uploaded_by_agent_id)
  values (p_object_id, p_storage_key, v_next, p_content_type,
          p_width, p_height, p_byte_size, v_agent)
  returning * into r;

  return r;
end $$;

comment on function attach_photo is
  'Инвариант 11. Порядок выводится на сервере, поэтому две одновременные загрузки не встанут на одно место.';

create or replace function reorder_photos(
  p_object_id uuid,
  p_keys      text[]
) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  n       integer;
begin
  if not exists (select 1 from mandates m
                  where m.object_id = p_object_id and m.status = 'active'
                    and (m.listing_agent_id = v_agent or app.is_admin())) then
    raise exception
      'INVARIANT_11: порядок фотографий меняет listing-агент действующего мандата'
      using errcode = '42501';
  end if;

  -- Перечислены должны быть ВСЕ фотографии объекта: частичный список оставил
  -- бы остальные на старых местах и поменял бы обложку незаметно.
  select count(*) into n from object_photos where object_id = p_object_id;
  if n <> coalesce(array_length(p_keys, 1), 0) then
    raise exception
      'INVARIANT_11: передано % ключей из %, перечислите все фотографии объекта',
      coalesce(array_length(p_keys, 1), 0), n
      using errcode = 'check_violation';
  end if;

  update object_photos p
     set sort_order = k.ord - 1
    from unnest(p_keys) with ordinality as k(key, ord)
   where p.object_id = p_object_id and p.storage_key = k.key;

  get diagnostics n = row_count;
  if n <> coalesce(array_length(p_keys, 1), 0) then
    raise exception 'INVARIANT_11: среди ключей есть чужие для этого объекта'
      using errcode = 'check_violation';
  end if;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on object_photos to authenticated;
grant select on public_photo_v to anon, authenticated;
revoke all on object_photos from anon;

-- Витрина пересобрана, значит права на неё надо выдать снова.
grant select on public_catalog_v to anon, authenticated;

grant execute on function
  attach_photo(uuid, text, text, integer, integer, integer),
  reorder_photos(uuid, text[])
  to authenticated;
