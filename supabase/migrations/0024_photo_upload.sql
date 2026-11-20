-- 0024_photo_upload.sql
-- Инвариант 11, продолжение: удаление фотографии, обложка и предел числа
-- фотографий на объект.
--
-- 0014 дала добавление и перестановку — всё, что нужно, чтобы фотографии
-- появились. Для экрана загрузки этого мало: загруженное иногда надо убрать,
-- обложку — поменять одним действием, а число фотографий — ограничить, иначе
-- первый же агент с телефоном на 128 ГБ покажет, почему это стоило сделать.
--
-- ПОРЯДОК ОСТАЁТСЯ СПЛОШНЫМ. Удаление без перенумерации оставило бы дыры
-- (0, 2, 3), а удаление первой — объект без нулевой позиции, то есть без
-- обложки. Обложка — это не отдельный флаг, а первая фотография, и значит
-- нулевая позиция обязана существовать, пока есть хоть одна фотография.

create or replace function app.max_photos_per_object() returns integer
  language sql immutable as $$ select 30 $$;

comment on function app.max_photos_per_object is
  'Инвариант 11. Предел числа фотографий на объект. Не вкусовщина: страница каталога и расходы на хранение у объекта с сотней фотографий другие.';

-- ---------------------------------------------------------------------------
-- Добавление с пределом
-- ---------------------------------------------------------------------------
-- Функция переопределяется целиком: меняется одна проверка, но дописать
-- в середину plpgsql нечем.

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
  v_count integer;
  r       object_photos;
begin
  if not exists (select 1 from mandates m
                  where m.object_id = p_object_id and m.status = 'active'
                    and (m.listing_agent_id = v_agent or app.is_admin())) then
    raise exception
      'INVARIANT_11: фотографии добавляет listing-агент действующего мандата'
      using errcode = '42501';
  end if;

  select count(*) into v_count from object_photos where object_id = p_object_id;
  if v_count >= app.max_photos_per_object() then
    raise exception
      'INVARIANT_11: у объекта уже % фотографий, это предел', v_count
      using errcode = 'check_violation',
            hint = 'Удалите лишние, прежде чем добавлять новые.';
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
  'Инвариант 11. Порядок выводится на сервере, поэтому две одновременные загрузки не встанут на одно место. Число фотографий ограничено.';

-- ---------------------------------------------------------------------------
-- Удаление
-- ---------------------------------------------------------------------------

create or replace function delete_photo(p_object_id uuid, p_storage_key text)
  returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_key   text;
begin
  if not exists (select 1 from mandates m
                  where m.object_id = p_object_id and m.status = 'active'
                    and (m.listing_agent_id = v_agent or app.is_admin())) then
    raise exception
      'INVARIANT_11: фотографии удаляет listing-агент действующего мандата'
      using errcode = '42501';
  end if;

  delete from object_photos
   where object_id = p_object_id and storage_key = p_storage_key
  returning storage_key into v_key;

  if v_key is null then
    raise exception 'INVARIANT_11: фотографии % у объекта % нет',
      p_storage_key, p_object_id
      using errcode = 'no_data_found';
  end if;

  -- Перенумерация: порядок должен остаться сплошным от нуля, иначе объект
  -- останется без обложки, стоит удалить первую фотографию.
  update object_photos p
     set sort_order = k.ord - 1
    from (select storage_key, row_number() over (order by sort_order) as ord
            from object_photos where object_id = p_object_id) k
   where p.object_id = p_object_id
     and p.storage_key = k.storage_key
     and p.sort_order <> k.ord - 1;

  -- Ключ возвращается, чтобы вызывающий убрал файл из хранилища. База
  -- файлами не распоряжается и знать о них не обязана.
  return v_key;
end $$;

comment on function delete_photo is
  'Инвариант 11. Удаляет фотографию и перенумеровывает остальные: порядок остаётся сплошным, обложка не исчезает.';

-- ---------------------------------------------------------------------------
-- Обложка
-- ---------------------------------------------------------------------------
-- reorder_photos() требует перечислить все ключи — это правильно для
-- перетаскивания и неудобно для одной кнопки «сделать обложкой». Здесь
-- то же правило, но одним действием.

create or replace function set_cover(p_object_id uuid, p_storage_key text)
  returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_keys text[];
begin
  if not exists (select 1 from object_photos
                  where object_id = p_object_id and storage_key = p_storage_key) then
    raise exception 'INVARIANT_11: фотографии % у объекта % нет',
      p_storage_key, p_object_id
      using errcode = 'no_data_found';
  end if;

  -- Выбранная первой, остальные в прежнем порядке. Проверку прав делает
  -- reorder_photos(): повторять её здесь значило бы завести второе место,
  -- где это правило написано.
  select array_agg(storage_key order by (storage_key <> p_storage_key), sort_order)
    into v_keys
    from object_photos where object_id = p_object_id;

  return reorder_photos(p_object_id, v_keys);
end $$;

comment on function set_cover is
  'Инвариант 11. Делает фотографию обложкой. Обложка — это первая фотография, отдельного флага у неё нет.';

-- ---------------------------------------------------------------------------
-- Фотографии объекта для кабинета
-- ---------------------------------------------------------------------------
-- public_photo_v отдаёт только фотографии опубликованных объектов — это
-- инвариант 11, и трогать его нельзя. Но агенту нужно видеть и фотографии
-- черновика, иначе загружать их некуда: объект публикуется ПОСЛЕ того, как
-- фотографии появились.
--
-- Поэтому отдельное представление с правами вызывающего: строки отдаёт
-- политика object_photos_read, то есть любой одобренный агент. Аноним сюда
-- не достаёт вовсе.

create or replace view cabinet_photo_v
  with (security_invoker = true) as
select
  p.object_id,
  p.storage_key,
  p.sort_order,
  p.content_type,
  p.width,
  p.height,
  p.byte_size,
  p.created_at,
  o.publication_state,
  (p.sort_order = 0) as is_cover
from object_photos p
join objects o on o.id = p.object_id;

comment on view cabinet_photo_v is
  'Фотографии объекта для кабинета, включая неопубликованные. Публичная отдача — public_photo_v, и она устроена иначе не случайно.';

grant select on cabinet_photo_v to authenticated;
revoke all on cabinet_photo_v from anon;

revoke execute on function
  delete_photo(uuid, text), set_cover(uuid, text),
  app.max_photos_per_object()
  from public;
grant execute on function
  delete_photo(uuid, text), set_cover(uuid, text),
  app.max_photos_per_object()
  to authenticated;
