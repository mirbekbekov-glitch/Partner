-- 0025_create_object.sql
-- ИНВАРИАНТ 19: объект заводится только вместе с собственником и договором.
--
-- Откуда это взялось. На экране кабинета есть объект «Черновик без мандата»,
-- и с ним нельзя ничего: опубликовать не даёт инвариант 1, фотографии
-- добавить не даёт инвариант 11, отчёт собственнику выдать некому — владельца
-- нет. Запись в базе есть, толку никакого, а в отчёте о подвисших объектах
-- она занимает строку.
--
-- Появился он законно: роли authenticated выдан insert на objects, и
-- политика проверяет только авторство. То есть система разрешала завести
-- объект, с которым сама же не даёт работать.
--
-- Три вещи, которые в жизни происходят одним разговором с собственником —
-- «вот квартира», «вот хозяин», «вот договор» — в базе были тремя
-- независимыми вставками, и между ними можно было остановиться.
--
-- Теперь объект создаётся одной функцией, и она создаёт всё сразу: объект,
-- связь с собственником и мандат. Прямую вставку у роли приложения отнимаем —
-- иначе правило остаётся советом.
--
-- ЧТО ОСТАЁТСЯ ВОЗМОЖНЫМ. Мандат можно завести отдельно: договор
-- перезаключают, а объект при этом тот же. Это другая операция, и запрещать
-- её незачем.

-- ---------------------------------------------------------------------------
-- Телефон контакта нормализуется
-- ---------------------------------------------------------------------------
-- Пробел в модели, записанный в README с первого дня: app.normalize_phone()
-- применялся только к агентам. Для контактов это значило, что «0700 11 22 33»
-- и «+996700112233» — разные номера, и один и тот же собственник заводился
-- дважды, а телефон одного из них не находился поиском.
--
-- Нормализуется то, что нормализуется. Номер, который функция не разбирает
-- (иностранный в непривычной записи, добавочный), сохраняется как введён:
-- выбрасывать контакт из-за формата номера — хуже, чем хранить его как есть.

create or replace function app.normalize_contact_phone() returns trigger
  language plpgsql as $$
declare v text;
begin
  v := app.normalize_phone(new.phone);
  if v is not null then
    new.phone := v;
  end if;
  return new;
end $$;

comment on function app.normalize_contact_phone is
  'Инвариант 19. Приводит телефон контакта к E.164, если это получается. Иначе оставляет как введён: контакт важнее формата.';

create trigger a_contact_phone_normalize
  before insert or update of phone on contact_phones
  for each row execute function app.normalize_contact_phone();

-- Разовая уборка уже записанного: иначе правило действует только на новое,
-- а поиск по номеру продолжает не находить старое.
update contact_phones
   set phone = app.normalize_phone(phone)
 where app.normalize_phone(phone) is not null
   and app.normalize_phone(phone) <> phone;

-- ---------------------------------------------------------------------------
-- Создание объекта
-- ---------------------------------------------------------------------------

create or replace function create_object(
  -- Объект
  p_kind               object_kind,
  p_deal_type          deal_type,
  p_address            text,
  p_price              numeric,
  -- Собственник: либо уже известный контакт, либо новый по имени и телефону
  p_contact_id         uuid    default null,
  p_owner_name         text    default null,
  p_owner_phone        text    default null,
  -- Договор
  p_mandate_kind       mandate_kind default 'non_exclusive',
  p_valid_to           date    default null,
  p_contract_confirmed boolean default false,
  -- Необязательное об объекте
  p_zone               text    default null,
  p_rooms              smallint default null,
  p_area               numeric default null,
  p_floor              smallint default null,
  p_floors_total       smallint default null,
  p_currency           text    default 'USD',
  p_description        text    default null,
  -- Если объект родился из объявления с площадки
  p_candidate_id       uuid    default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_contact_id;
  v_phone   text := nullif(btrim(coalesce(p_owner_phone, '')), '');
  v_object  objects;
begin
  -- ---- собственник -------------------------------------------------------
  if v_contact is null and v_phone is null then
    raise exception 'INVARIANT_19: у объекта должен быть собственник: укажите контакт или имя с телефоном'
      using errcode = 'not_null_violation',
            hint = 'Объект без владельца нельзя ни опубликовать, ни показать, ни отчитаться по нему.';
  end if;

  if v_contact is not null then
    -- Функция security definer обходит построчные политики, поэтому право
    -- на чужой контакт проверяется здесь явно. Иначе по угаданному
    -- идентификатору к объекту прицепился бы чужой собственник.
    if not app.can_see_contact(v_contact) then
      raise exception 'FORBIDDEN: этот контакт вам не виден'
        using errcode = '42501';
    end if;
  else
    -- Тот же номер — тот же человек. Собственник с двумя квартирами не
    -- должен превращаться в два контакта: телефон у него один, и история
    -- работы с ним должна быть одна.
    select cp.contact_id into v_contact
      from contact_phones cp
     where cp.phone = coalesce(app.normalize_phone(v_phone), v_phone)
     limit 1;

    if v_contact is null then
      if nullif(btrim(coalesce(p_owner_name, '')), '') is null then
        raise exception 'INVARIANT_19: у нового собственника должно быть имя'
          using errcode = 'not_null_violation';
      end if;

      insert into contacts (name, roles, owner_agent_id, source)
      values (btrim(p_owner_name), array['owner']::contact_role[], v_agent,
              case when p_candidate_id is not null then 'объявление с площадки'
                   else 'заведён при создании объекта' end)
      returning id into v_contact;

      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, v_phone, true);
    end if;
  end if;

  -- ---- объект ------------------------------------------------------------
  insert into objects (kind, deal_type, address, zone, rooms, area, floor,
                       floors_total, price, currency, description,
                       created_by_agent_id)
  values (p_kind, p_deal_type, btrim(p_address), nullif(btrim(coalesce(p_zone, '')), ''),
          p_rooms, p_area, p_floor, p_floors_total, p_price,
          upper(coalesce(nullif(btrim(p_currency), ''), 'USD')),
          nullif(btrim(coalesce(p_description, '')), ''), v_agent)
  returning * into v_object;

  -- ---- собственность -----------------------------------------------------
  insert into object_ownerships (object_id, contact_id, role, share)
  values (v_object.id, v_contact, 'owner', 1);

  -- ---- договор -----------------------------------------------------------
  -- Стартовая цена равна цене объекта: это один и тот же разговор с
  -- собственником. Разойтись они могут потом, и тогда это осознанная правка.
  insert into mandates (object_id, kind, valid_to, start_price,
                        listing_agent_id, contract_confirmed, status)
  values (v_object.id, p_mandate_kind, p_valid_to, p_price,
          v_agent, p_contract_confirmed, 'active');

  -- ---- объявление с площадки ---------------------------------------------
  -- Закрывается тем же вызовом: кандидат, превращённый в объект, не должен
  -- остаться висеть в пуле, а агент — помнить про второе действие.
  if p_candidate_id is not null then
    perform convert_candidate(p_candidate_id, v_object.id);
  end if;

  return v_object;
end $$;

comment on function create_object is
  'Инвариант 19. Заводит объект вместе с собственником и договором одним действием. Объект без владельца или без мандата создать нельзя.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
-- Прямая вставка отнимается: без неё правило выше — не совет, а правило.
-- Чтение, правка и удаление остаются: их ограничивают построчные политики.

revoke insert on objects from authenticated;

revoke execute on function create_object(
  object_kind, deal_type, text, numeric, uuid, text, text, mandate_kind, date,
  boolean, text, smallint, numeric, smallint, smallint, text, text, uuid)
  from public;
grant execute on function create_object(
  object_kind, deal_type, text, numeric, uuid, text, text, mandate_kind, date,
  boolean, text, smallint, numeric, smallint, smallint, text, text, uuid)
  to authenticated;

revoke execute on function app.normalize_contact_phone() from public;
