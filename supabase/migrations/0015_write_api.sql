-- 0015_write_api.sql
-- Создание и правка объектов и потребностей из кабинета.
--
-- Всё одной транзакцией в функции, а не серией вставок из кода. Причина
-- прямая: объект без мандата опубликовать нельзя (инвариант 1), поэтому
-- «создали объект, потом мандат, потом связь с собственником» на любой
-- оборванной середине оставляет объект, с которым нельзя работать.

-- ---------------------------------------------------------------------------
-- Кто может править объект
-- ---------------------------------------------------------------------------
-- В 0006 править объект мог ЛЮБОЙ одобренный агент: политика проверяла
-- только `app.current_agent_id() is not null`. Пока правки делались через
-- SQL, это было терпимо; с появлением формы это значит, что любой агент
-- молча переписывает цены и фото в чужих объектах.
--
-- Сужаю до тех, кто за объект отвечает: кто его завёл, listing-агент
-- активного мандата и админ. РЕШЕНИЕ ОБРАТИМО: если в агентстве принято
-- править объекты сообща, политику можно вернуть к прежнему виду.

drop policy objects_update on objects;

create policy objects_update on objects for update
  using (
    created_by_agent_id = app.current_agent_id()
    or app.is_admin()
    or exists (
      select 1 from mandates m
       where m.object_id = objects.id
         and m.status = 'active'
         and m.listing_agent_id = app.current_agent_id()
    )
  )
  with check (
    created_by_agent_id = app.current_agent_id()
    or app.is_admin()
    or exists (
      select 1 from mandates m
       where m.object_id = objects.id
         and m.status = 'active'
         and m.listing_agent_id = app.current_agent_id()
    )
  );

comment on policy objects_update on objects is
  'Править объект может тот, кто его завёл, listing-агент активного мандата и админ. Остальные агенты объект видят, но не меняют.';

create or replace function app.can_edit_object(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or exists (select 1 from objects o
                  where o.id = p_object_id
                    and o.created_by_agent_id = app.current_agent_id())
      or exists (select 1 from mandates m
                  where m.object_id = p_object_id
                    and m.status = 'active'
                    and m.listing_agent_id = app.current_agent_id())
$$;

grant execute on function app.can_edit_object(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Разбор того, что присылает форма
-- ---------------------------------------------------------------------------

-- Разбор списков из формы: «Центр, Юг» или по строкам.
create or replace function app.strings_from_lines(p_text text) returns text[]
  language sql immutable as $$
  select coalesce(
    array_agg(t.v order by t.v),
    '{}'::text[])
  from (
    select distinct btrim(unnest(string_to_array(
      replace(coalesce(p_text, ''), E'\n', ','), ','))) as v
  ) t
  where t.v <> ''
$$;

create or replace function app.smallints_from_lines(p_text text) returns smallint[]
  language sql immutable as $$
  select coalesce(array_agg(t.v::smallint order by t.v::smallint), '{}'::smallint[])
  from (
    select distinct btrim(unnest(string_to_array(
      replace(coalesce(p_text, ''), E'\n', ','), ','))) as v
  ) t
  where t.v ~ '^[0-9]{1,2}$'
$$;

-- ---------------------------------------------------------------------------
-- Фото: строки в jsonb-массив
-- ---------------------------------------------------------------------------
-- Форма отдаёт ссылки по одной в строке. Загрузки файлов нет — это отдельная
-- работа со Storage; здесь только адреса.

create or replace function app.photos_from_lines(p_lines text) returns jsonb
  language sql immutable as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object('url', t.line))
       from (select btrim(unnest(string_to_array(coalesce(p_lines, ''), E'\n'))) as line) t
      where t.line <> ''),
    '[]'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- Создание объекта
-- ---------------------------------------------------------------------------

create or replace function create_object(
  p_kind                object_kind,
  p_deal_type           deal_type,
  p_address             text,
  p_price               numeric,
  p_zone                text    default null,
  p_rooms               smallint default null,
  p_area                numeric default null,
  p_floor               smallint default null,
  p_floors_total        smallint default null,
  p_currency            text    default 'USD',
  p_description         text    default null,
  p_photos              text    default null,
  -- Собственник: либо ссылка на существующий контакт, либо новый по имени.
  p_owner_contact_id    uuid    default null,
  p_owner_name          text    default null,
  p_owner_phone         text    default null,
  -- Мандат. Задан вид — мандат создаётся, и объект сразу можно публиковать.
  p_mandate_kind        mandate_kind default null,
  p_mandate_valid_to    date    default null,
  p_mandate_start_price numeric default null,
  p_contract_confirmed  boolean default false,
  p_document_url        text    default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_owner_contact_id;
  r         objects;
begin
  insert into objects (
    kind, deal_type, address, zone, rooms, area, floor, floors_total,
    price, currency, description, photos, created_by_agent_id, publication_state
  ) values (
    p_kind, p_deal_type, btrim(p_address), nullif(btrim(coalesce(p_zone, '')), ''),
    p_rooms, p_area, p_floor, p_floors_total,
    p_price, coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'USD'),
    nullif(btrim(coalesce(p_description, '')), ''),
    app.photos_from_lines(p_photos),
    v_agent,
    -- Всегда черновик. Публикация — отдельный шаг, и он требует мандата.
    'draft'
  ) returning * into r;

  -- Собственник. Новый контакт достаётся тому, кто его привёл: на этом
  -- держится инвариант 4.
  if v_contact is null and length(btrim(coalesce(p_owner_name, ''))) > 0 then
    insert into contacts (name, owner_agent_id, roles, source)
    values (btrim(p_owner_name), v_agent,
            case when p_deal_type = 'rent' then '{owner,landlord}'::contact_role[]
                 else '{owner}'::contact_role[] end,
            'заведён с объектом')
    returning id into v_contact;

    if length(btrim(coalesce(p_owner_phone, ''))) > 0 then
      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, btrim(p_owner_phone), true);
    end if;
  end if;

  if v_contact is not null then
    insert into object_ownerships (object_id, contact_id, role, share)
    values (r.id, v_contact, 'owner', 1)
    on conflict do nothing;
  end if;

  -- Мандат.
  if p_mandate_kind is not null then
    insert into mandates (
      object_id, kind, valid_to, start_price, listing_agent_id,
      contract_confirmed, document_url, status
    ) values (
      r.id, p_mandate_kind, p_mandate_valid_to,
      coalesce(p_mandate_start_price, p_price), v_agent,
      coalesce(p_contract_confirmed, false),
      nullif(btrim(coalesce(p_document_url, '')), ''),
      'active'
    );
  end if;

  return r;
end $$;

comment on function create_object is
  'Объект, собственник и мандат одной транзакцией. Объект всегда создаётся черновиком: публикация — отдельный шаг, требующий мандата (инвариант 1).';

-- ---------------------------------------------------------------------------
-- Правка объекта
-- ---------------------------------------------------------------------------
-- Форма показывает все поля и присылает их целиком, поэтому функция их
-- целиком и записывает. actual_at и published_at не трогаем руками:
-- ими распоряжается триггер инварианта 5.

create or replace function update_object(
  p_id           uuid,
  p_kind         object_kind,
  p_deal_type    deal_type,
  p_address      text,
  p_price        numeric,
  p_zone         text    default null,
  p_rooms        smallint default null,
  p_area         numeric default null,
  p_floor        smallint default null,
  p_floors_total smallint default null,
  p_currency     text    default 'USD',
  p_description  text    default null,
  p_photos       text    default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if not app.can_edit_object(p_id) then
    raise exception 'FORBIDDEN: править объект может тот, кто его завёл, listing-агент активного мандата или админ'
      using errcode = '42501';
  end if;

  update objects set
    kind         = p_kind,
    deal_type    = p_deal_type,
    address      = btrim(p_address),
    zone         = nullif(btrim(coalesce(p_zone, '')), ''),
    rooms        = p_rooms,
    area         = p_area,
    floor        = p_floor,
    floors_total = p_floors_total,
    price        = p_price,
    currency     = coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'USD'),
    description  = nullif(btrim(coalesce(p_description, '')), ''),
    photos       = app.photos_from_lines(p_photos)
  where id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Мандат объекта
-- ---------------------------------------------------------------------------
-- Нужен кабинету: без него созданный объект невозможно опубликовать, и
-- форма создания оставалась бы единственным путём завести договор.

create or replace function create_mandate(
  p_object_id          uuid,
  p_kind               mandate_kind,
  p_start_price        numeric default null,
  p_valid_to           date    default null,
  p_contract_confirmed boolean default false,
  p_document_url       text    default null,
  p_commission_rule    jsonb   default null
) returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       mandates;
begin
  -- Единственность активного мандата держит partial unique index из 0002;
  -- здесь только понятное сообщение вместо ошибки про индекс.
  if app.active_mandate_id(p_object_id) is not null then
    raise exception 'INVARIANT_1: у объекта уже есть активный мандат'
      using errcode = 'check_violation',
            hint = 'Сначала расторгните действующий договор.';
  end if;

  insert into mandates (
    object_id, kind, start_price, valid_to, listing_agent_id,
    contract_confirmed, document_url, commission_rule, status
  ) values (
    p_object_id, p_kind,
    coalesce(p_start_price, (select price from objects where id = p_object_id)),
    p_valid_to, v_agent,
    coalesce(p_contract_confirmed, false),
    nullif(btrim(coalesce(p_document_url, '')), ''),
    p_commission_rule, 'active'
  ) returning * into r;

  return r;
end $$;

create or replace function terminate_mandate(p_mandate_id uuid, p_reason text default null)
  returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r mandates;
begin
  perform app.require_agent();

  if not exists (
    select 1 from mandates m
     where m.id = p_mandate_id
       and (m.listing_agent_id = app.current_agent_id() or app.is_admin())
  ) then
    raise exception 'FORBIDDEN: расторгнуть договор может его listing-агент или админ'
      using errcode = '42501';
  end if;

  -- Триггер d_mandate_release_withdraws_object снимет объект с публикации
  -- и с каналов: без активного мандата он в каталоге быть не может.
  update mandates
     set status = 'terminated',
         closed_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_mandate_id and status = 'active'
  returning * into r;

  if r.id is null then
    raise exception 'активный мандат % не найден', p_mandate_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Создание потребности
-- ---------------------------------------------------------------------------

create or replace function create_requirement(
  p_deal_type        deal_type,
  p_contact_id       uuid    default null,
  p_client_name      text    default null,
  p_client_phone     text    default null,
  p_budget_min       numeric default null,
  p_budget_max       numeric default null,
  p_zones            text    default null,
  p_rooms            text    default null,
  p_deadline         date    default null,
  p_requirements_text text   default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_contact_id;
  r         requirements;
begin
  if v_contact is null and length(btrim(coalesce(p_client_name, ''))) > 0 then
    insert into contacts (name, owner_agent_id, roles, source)
    values (btrim(p_client_name), v_agent,
            case when p_deal_type = 'rent' then '{tenant}'::contact_role[]
                 else '{buyer}'::contact_role[] end,
            'заведён с потребностью')
    returning id into v_contact;

    if length(btrim(coalesce(p_client_phone, ''))) > 0 then
      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, btrim(p_client_phone), true);
    end if;
  end if;

  if v_contact is null then
    raise exception 'потребность без клиента невозможна: укажите контакт или имя'
      using errcode = 'check_violation';
  end if;

  insert into requirements (
    contact_id, deal_type, budget_min, budget_max, zones, rooms,
    deadline, requirements_text, agent_id, status
  ) values (
    v_contact, p_deal_type, p_budget_min, p_budget_max,
    app.strings_from_lines(p_zones),
    app.smallints_from_lines(p_rooms),
    p_deadline, nullif(btrim(coalesce(p_requirements_text, '')), ''),
    v_agent, 'new'
  ) returning * into r;

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Правка потребности
-- ---------------------------------------------------------------------------

create or replace function update_requirement(
  p_id               uuid,
  p_deal_type        deal_type,
  p_budget_min       numeric default null,
  p_budget_max       numeric default null,
  p_zones            text    default null,
  p_rooms            text    default null,
  p_deadline         date    default null,
  p_requirements_text text   default null,
  p_status           requirement_status default null,
  p_closed_reason    text    default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old requirements%rowtype;
  r     requirements;
begin
  perform app.require_agent();

  select * into v_old from requirements where id = p_id;
  if not found then
    raise exception 'потребность % не найдена', p_id using errcode = 'no_data_found';
  end if;

  if not (v_old.agent_id = app.current_agent_id() or app.is_admin()) then
    raise exception 'FORBIDDEN: править потребность может ведущий её агент или админ'
      using errcode = '42501';
  end if;

  -- Статус «в сделке» руками не ставится: он означает, что по подбору
  -- создана сделка, и приходит из create_deal_from_match (инвариант 2).
  -- Иначе потребность показывала бы сделку, которой нет.
  if p_status = 'in_deal' and v_old.status <> 'in_deal' then
    raise exception 'INVARIANT_2: статус «в сделке» ставится созданием сделки из подбора, а не вручную'
      using errcode = 'check_violation';
  end if;

  update requirements set
    deal_type         = p_deal_type,
    budget_min        = p_budget_min,
    budget_max        = p_budget_max,
    zones             = app.strings_from_lines(p_zones),
    rooms             = app.smallints_from_lines(p_rooms),
    deadline          = p_deadline,
    requirements_text = nullif(btrim(coalesce(p_requirements_text, '')), ''),
    status            = coalesce(p_status, v_old.status),
    closed_reason     = nullif(btrim(coalesce(p_closed_reason, '')), '')
  where id = p_id
  returning * into r;

  return r;
end $$;

grant execute on function
  create_object(object_kind, deal_type, text, numeric, text, smallint, numeric,
                smallint, smallint, text, text, text, uuid, text, text,
                mandate_kind, date, numeric, boolean, text),
  update_object(uuid, object_kind, deal_type, text, numeric, text, smallint,
                numeric, smallint, smallint, text, text, text),
  create_mandate(uuid, mandate_kind, numeric, date, boolean, text, jsonb),
  terminate_mandate(uuid, text),
  create_requirement(deal_type, uuid, text, text, numeric, numeric, text, text, date, text),
  update_requirement(uuid, deal_type, numeric, numeric, text, text, date, text,
                     requirement_status, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Публичная обёртка: право на правку спрашивает страница
-- ---------------------------------------------------------------------------
-- Страница правки не выводит право сама: про listing-агента активного
-- мандата и про админа знает только база.

create or replace function can_edit_object(p_object_id uuid) returns boolean
  language sql security definer set search_path = public, pg_temp as $$
  select app.can_edit_object(p_object_id)
$$;

grant execute on function can_edit_object(uuid) to authenticated;
