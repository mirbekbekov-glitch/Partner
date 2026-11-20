-- 0028_editing.sql
-- ИНВАРИАНТ 22: объект ведёт listing-агент действующего договора. Он один
--               правит данные объекта, публикует его, снимает и подтверждает
--               актуальность.
--
-- Найдено тем же способом — запросом от имени постороннего агента:
--
--     update objects set price = 1 where id = <чужой объект>;
--
-- Цена чужого объекта поменялась с 85 000 на 1. Политика objects_update
-- проверяла только «одобренный агент», то есть любой сотрудник агентства мог
-- переписать цену, адрес и описание чужого объекта. Мандат и потребность при
-- той же проверке устояли — у них политики написаны по владельцу.
--
-- То же и в функциях: publish_object(), withdraw_object() и
-- app.confirm_actual() спрашивали app.require_agent() и больше ничего.
-- «Агент» — это не «этот агент», и это уже третий инвариант, который
-- начинается с этой фразы (17, 21, 22).
--
-- ПОЧЕМУ ИМЕННО LISTING-АГЕНТ, а не тот, кто завёл объект. Отвечает перед
-- собственником тот, с кем у собственника договор. Создатель записи может
-- быть кем угодно — например, объект завели из объявления, а договор
-- заключил другой агент. Фотографии (инвариант 11) уже устроены так же:
-- одно правило, одно понятие «свой объект».
--
-- Подтверждение актуальности — тоже правка, хотя и не меняет полей: агент
-- заявляет собственнику и покупателям, что цена и фотографии ещё в силе.
-- Заявлять это за чужой объект нельзя.

create or replace function app.is_listing_agent(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from mandates m
     where m.object_id = p_object_id
       and m.status = 'active'
       and m.listing_agent_id = app.current_agent_id())
$$;

comment on function app.is_listing_agent is
  'Инвариант 22. Ведёт ли текущий агент этот объект: есть ли у него действующий договор с собственником.';

-- ---------------------------------------------------------------------------
-- Триггер: правит тот, кто ведёт
-- ---------------------------------------------------------------------------
-- В триггере, а не в функциях: роли приложения выдан update на objects, и
-- правило, живущее только в функциях, обходится одной строкой.

create or replace function app.check_object_editor() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  -- Правило касается запросов от вошедшего человека. Плановые работы,
  -- миграции и перенос идут без входа и правило не нарушают.
  if auth.uid() is null or app.is_admin() then
    return new;
  end if;

  if app.is_listing_agent(new.id) then
    return new;
  end if;

  -- Дальше — случаи, когда действующего договора у объекта нет вовсе.
  if not exists (select 1 from mandates m
                  where m.object_id = new.id and m.status = 'active') then

    -- Снятие с публикации вслед за закрытым или истёкшим договором. Это не
    -- правка, а требование инварианта 1, и выполняет его тот, кто закрыл
    -- сделку, — а он чаще всего агент покупателя, а не владелец мандата.
    -- Первая версия этого триггера такой каскад блокировала, и тесты
    -- инвариантов 2, 3 и 4 покраснели все сразу.
    if new.publication_state is distinct from old.publication_state
       and new.publication_state <> 'published' then
      return new;
    end if;

    -- Прочее по объекту без договора правит тот, кто его завёл: иначе объект
    -- с истёкшим мандатом становится неисправимым, и даже заключить новый
    -- договор по нему будет нельзя.
    if new.created_by_agent_id = app.current_agent_id() then
      return new;
    end if;
  end if;

  raise exception 'INVARIANT_22: объект ведёт агент действующего договора'
    using errcode = '42501',
          hint = 'По этому объекту договор у другого агента.';
end $$;

comment on function app.check_object_editor is
  'Инвариант 22. Правит объект listing-агент действующего договора; объект без договора — тот, кто его завёл.';

-- Имя с «d», чтобы правило о договоре (c_objects_publication_requires_mandate,
-- инвариант 1) говорило первым: объект без мандата нельзя публиковать вообще
-- никому, и слышать про это надо раньше, чем про то, кто его ведёт.
create trigger d_object_editor
  before update on objects
  for each row execute function app.check_object_editor();

-- ---------------------------------------------------------------------------
-- Понятные отказы в функциях
-- ---------------------------------------------------------------------------

create or replace function publish_object(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  -- Сначала договор, потом агент: без мандата публиковать нельзя никому, и
  -- это объясняет положение дел лучше, чем «не ваш объект».
  if app.active_mandate_id(p_object_id) is null then
    raise exception
      'INVARIANT_1: объект нельзя опубликовать без активного мандата'
      using errcode = 'check_violation',
            hint = 'Заключите мандат с собственником, затем публикуйте.';
  end if;

  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_22: публикует объект агент действующего договора'
      using errcode = '42501';
  end if;

  update objects set publication_state = 'published'
   where id = p_object_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

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

  update publication_channels
     set status = 'withdrawn', last_sync_at = now()
   where object_id = p_object_id and status in ('exported', 'updated');

  return r;
end $$;

create or replace function app.confirm_actual(p_object_id uuid) returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v timestamptz;
begin
  perform app.require_agent();

  -- Подтверждение — заявление собственнику и покупателям, что цена и
  -- фотографии ещё в силе. За чужой объект такого не заявляют.
  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_22: актуальность подтверждает агент действующего договора'
      using errcode = '42501';
  end if;

  update objects set actual_at = now() where id = p_object_id
    returning actual_at into v;
  if v is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Правка объекта
-- ---------------------------------------------------------------------------
-- Цена, адрес и описание меняются одним вызовом. Правка цены и описания
-- поднимает actual_at (инвариант 5) — это делает триггер, а не эта функция:
-- правило одно и работает при любом пути.

create or replace function update_object(
  p_object_id    uuid,
  p_price        numeric,
  p_address      text,
  p_zone         text     default null,
  p_rooms        smallint default null,
  p_area         numeric  default null,
  p_floor        smallint default null,
  p_floors_total smallint default null,
  p_currency     text     default null,
  p_description  text     default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if p_price is null or p_price <= 0 then
    raise exception 'цена должна быть больше нуля' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_address, '')), '') is null then
    raise exception 'адрес обязателен' using errcode = 'check_violation';
  end if;

  -- Право на правку проверяет триггер b_object_editor: одно правило на все
  -- пути, включая прямой UPDATE.
  update objects
     set price        = p_price,
         address      = btrim(p_address),
         zone         = nullif(btrim(coalesce(p_zone, '')), ''),
         rooms        = p_rooms,
         area         = p_area,
         floor        = p_floor,
         floors_total = p_floors_total,
         currency     = upper(coalesce(nullif(btrim(coalesce(p_currency, '')), ''), currency)),
         description  = nullif(btrim(coalesce(p_description, '')), '')
   where id = p_object_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function update_object is
  'Инвариант 22. Правка объекта. Право проверяет триггер, актуальность поднимает a_object_timestamps.';

-- ---------------------------------------------------------------------------
-- Правка договора
-- ---------------------------------------------------------------------------

create or replace function update_mandate(
  p_mandate_id         uuid,
  p_kind               mandate_kind,
  p_valid_to           date    default null,
  p_contract_confirmed boolean default null
) returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       mandates;
begin
  if not exists (select 1 from mandates m
                  where m.id = p_mandate_id
                    and (m.listing_agent_id = v_agent or app.is_admin())) then
    raise exception 'INVARIANT_22: условия договора меняет его владелец'
      using errcode = '42501';
  end if;

  update mandates
     set kind               = p_kind,
         valid_to           = p_valid_to,
         contract_confirmed = coalesce(p_contract_confirmed, contract_confirmed)
   where id = p_mandate_id
  returning * into r;

  return r;
end $$;

comment on function update_mandate is
  'Инвариант 22. Правка условий договора владельцем мандата. Ставку агента покупателя меняет set_closing_share().';

-- ---------------------------------------------------------------------------
-- Правка потребности
-- ---------------------------------------------------------------------------

create or replace function update_requirement(
  p_requirement_id uuid,
  p_budget_min     numeric    default null,
  p_budget_max     numeric    default null,
  p_zones          text[]     default '{}',
  p_rooms          smallint[] default '{}',
  p_deadline       date       default null,
  p_text           text       default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       requirements;
begin
  if not exists (select 1 from requirements rq
                  where rq.id = p_requirement_id
                    and (rq.agent_id = v_agent or app.is_admin())) then
    raise exception 'INVARIANT_22: потребность правит её агент'
      using errcode = '42501';
  end if;

  update requirements
     set budget_min        = p_budget_min,
         budget_max        = p_budget_max,
         zones             = coalesce(p_zones, '{}'),
         rooms             = coalesce(p_rooms, '{}'),
         deadline          = p_deadline,
         requirements_text = nullif(btrim(coalesce(p_text, '')), '')
   where id = p_requirement_id
  returning * into r;

  return r;
end $$;

comment on function update_requirement is
  'Инвариант 22. Правка условий потребности её агентом.';

-- ---------------------------------------------------------------------------
-- Правка контакта
-- ---------------------------------------------------------------------------
-- Имя записывают со слуха, и ошибаются в нём чаще всего. Телефон правится
-- здесь же: он нормализуется триггером инварианта 19, и совпадение с чужим
-- номером не страшно — контакты по номеру не склеиваются задним числом.

create or replace function update_contact(
  p_contact_id uuid,
  p_name       text,
  p_phone      text default null
) returns contacts
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  r       contacts;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'имя обязательно' using errcode = 'check_violation';
  end if;

  if not app.can_see_contact(p_contact_id) then
    raise exception 'FORBIDDEN: этот контакт вам не виден'
      using errcode = '42501';
  end if;

  if not exists (select 1 from contacts c
                  where c.id = p_contact_id
                    and (c.owner_agent_id = v_agent or app.is_admin())) then
    raise exception 'INVARIANT_22: контакт правит агент, который его ведёт'
      using errcode = '42501';
  end if;

  update contacts set name = btrim(p_name) where id = p_contact_id
  returning * into r;

  if v_phone is not null then
    -- Основной телефон один: правка меняет его, а не добавляет второй.
    if exists (select 1 from contact_phones cp
                where cp.contact_id = p_contact_id and cp.is_primary) then
      update contact_phones set phone = v_phone
       where contact_id = p_contact_id and is_primary;
    else
      insert into contact_phones (contact_id, phone, is_primary)
      values (p_contact_id, v_phone, true);
    end if;
  end if;

  return r;
end $$;

comment on function update_contact is
  'Инвариант 22. Правка имени и основного телефона контакта агентом, который его ведёт.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function app.check_object_editor() from public;
revoke execute on function app.is_listing_agent(uuid) from public;
revoke execute on function
  update_object(uuid, numeric, text, text, smallint, numeric, smallint, smallint, text, text),
  update_mandate(uuid, mandate_kind, date, boolean),
  update_requirement(uuid, numeric, numeric, text[], smallint[], date, text),
  update_contact(uuid, text, text)
  from public;

grant execute on function app.is_listing_agent(uuid) to authenticated;
grant execute on function
  update_object(uuid, numeric, text, text, smallint, numeric, smallint, smallint, text, text),
  update_mandate(uuid, mandate_kind, date, boolean),
  update_requirement(uuid, numeric, numeric, text[], smallint[], date, text),
  update_contact(uuid, text, text)
  to authenticated;
