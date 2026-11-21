-- 0041_listing_funnel.sql
-- ИНВАРИАНТ 32: объект живёт в работе раньше, чем появляется договор.
--
-- Это исправление ошибки, которую показала рабочая база агентства. У них в
-- воронке продажи 557 объектов на этапе «Новый объект», 4 на «Обзвоне», 4 на
-- «Осмотре и оценке» и 26 «В работе БЕЗ ДОГОВОРА» — и только после этого
-- «Договор подписан». То есть объект существует и с ним работают задолго до
-- того, как появляется хоть какой-то договор.
--
-- А у нас объект без договора завести было НЕЛЬЗЯ: create_object() создавал
-- объект, собственника и мандат одним действием. Первые три этапа работы с
-- собственником хранить было негде, и агент, у которого ещё нет договора,
-- просто не мог занести объект в систему. Он заносил его в WhatsApp.
--
-- И вторая дыра, которую нашла проба: функции «заключить договор по уже
-- существующему объекту» не существовало вовсе. Мандат рождался только
-- внутри create_object(). Подписать договор по объекту, который завели вчера,
-- было нечем.
--
-- ЧТО ОСТАЁТСЯ НЕИЗМЕННЫМ. Инвариант 1: без действующего мандата объект не
-- публикуется. Он про каталог, а не про работу, и проба это подтвердила —
-- объект без мандата в каталог не попадает, в подбор клиенту не попадает и
-- опубликоваться не может. Менять там нечего.
--
-- ЧТО ТАКОЕ «ВЗЯТ В РАБОТУ». Ответ владельца продукта: договор. Поэтому
-- граница в воронке проходит ровно по `contract_confirmed`, и она же решает,
-- что видит коллега.

-- ---------------------------------------------------------------------------
-- Этап работы с собственником
-- ---------------------------------------------------------------------------
-- Ранние этапы — решения агента: позвонил, съездил. Их не из чего вывести, и
-- они хранятся. Поздние — факты: есть договор, он подписан, объект в
-- каталоге, по нему идёт сделка. Их хранить нельзя, иначе появится вторая
-- правда (урок инварианта 30).

create type owner_stage as enum ('new', 'called', 'visited');

comment on type owner_stage is
  'Ранние этапы работы с собственником, которые не выводятся из фактов: объект заведён, с собственником говорили, объект осмотрели. Дальше воронку ведут факты.';

alter table objects add column owner_stage owner_stage not null default 'new';
alter table objects add column owner_stage_since timestamptz not null default now();

comment on column objects.owner_stage is
  'Инвариант 32. Докуда дошла работа с собственником до договора. После появления договора колонку воронки определяет факт, а не это поле.';

create or replace function app.touch_owner_stage() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.owner_stage is distinct from old.owner_stage then
    new.owner_stage_since := now();
  end if;
  return new;
end $$;

create trigger a_owner_stage_since
  before update on objects
  for each row execute function app.touch_owner_stage();

-- Назад по ранним этапам не ходят: «позвонили» не перестаёт быть правдой
-- оттого, что передумали. Это тот же запрет, что в инварианте 30.
create or replace function app.check_owner_stage() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.owner_stage is not distinct from old.owner_stage then
    return new;
  end if;

  if array_position(enum_range(null::owner_stage), new.owner_stage)
     < array_position(enum_range(null::owner_stage), old.owner_stage) then
    raise exception
      'INVARIANT_32: назад по работе с собственником не ходят: «%» уже было',
      old.owner_stage
      using errcode = 'check_violation',
            hint = 'Если работа начата заново — это новый объект, а не откат.';
  end if;

  return new;
end $$;

create trigger c_owner_stage
  before update of owner_stage on objects
  for each row execute function app.check_owner_stage();

-- ---------------------------------------------------------------------------
-- Объект без договора
-- ---------------------------------------------------------------------------
-- Собственник обязателен и здесь: объект, по которому некому звонить, в
-- воронке бесполезен. А вот договор — нет.

create or replace function register_object(
  p_kind        object_kind,
  p_deal_type   deal_type,
  p_address     text,
  p_price       numeric,
  p_contact_id  uuid    default null,
  p_owner_name  text    default null,
  p_owner_phone text    default null,
  p_zone        text    default null,
  p_rooms       smallint default null,
  p_area        numeric default null,
  p_floor       smallint default null,
  p_floors_total smallint default null,
  p_currency    text    default 'USD',
  p_description text    default null,
  p_candidate_id uuid   default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_contact_id;
  v_phone   text := nullif(btrim(coalesce(p_owner_phone, '')), '');
  v_object  objects;
begin
  if v_contact is null and v_phone is null then
    raise exception 'INVARIANT_19: у объекта должен быть собственник: укажите контакт или имя с телефоном'
      using errcode = 'not_null_violation',
            hint = 'Объект, по которому некому звонить, в воронке бесполезен.';
  end if;

  if v_contact is not null then
    if not app.can_see_contact(v_contact) then
      raise exception 'FORBIDDEN: этот контакт вам не виден' using errcode = '42501';
    end if;
  else
    -- Тот же номер — тот же человек (инвариант 19).
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

  insert into objects (kind, deal_type, address, zone, rooms, area, floor,
                       floors_total, price, currency, description,
                       created_by_agent_id)
  values (p_kind, p_deal_type, btrim(p_address), nullif(btrim(coalesce(p_zone, '')), ''),
          p_rooms, p_area, p_floor, p_floors_total, p_price,
          upper(coalesce(nullif(btrim(p_currency), ''), 'USD')),
          nullif(btrim(coalesce(p_description, '')), ''), v_agent)
  returning * into v_object;

  insert into object_ownerships (object_id, contact_id, role, share)
  values (v_object.id, v_contact, 'owner', 1);

  if p_candidate_id is not null then
    perform convert_candidate(p_candidate_id, v_object.id);
  end if;

  return v_object;
end $$;

comment on function register_object is
  'Инвариант 32. Заводит объект с собственником, но БЕЗ договора: так начинается работа. В каталог такой объект не попадает (инвариант 1) и клиенту не предлагается (инвариант 20).';

-- ---------------------------------------------------------------------------
-- Заключить договор
-- ---------------------------------------------------------------------------
-- Этого не было вовсе: мандат рождался только внутри create_object(), и
-- подписать договор по уже заведённому объекту было нечем. Нашлось пробой.

create or replace function sign_mandate(
  p_object_id uuid,
  p_kind      mandate_kind default 'non_exclusive',
  p_valid_to  date    default null,
  p_start_price numeric default null,
  p_confirmed boolean default false
) returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  o       objects%rowtype;
  r       mandates;
begin
  select * into o from objects where id = p_object_id;
  if not found then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  -- Договор заключает тот, кто ведёт объект. Для объекта без договора это
  -- тот, кто его завёл (инвариант 22), и администратор.
  if auth.uid() is not null
     and not app.is_admin()
     and o.created_by_agent_id is distinct from v_agent
     and not app.is_listing_agent(p_object_id) then
    raise exception 'INVARIANT_32: договор заключает агент, который ведёт объект'
      using errcode = '42501';
  end if;

  -- Договор нужен объекту, у которого собственник известен: иначе непонятно,
  -- с кем он заключён.
  if not exists (select 1 from object_ownerships oo
                  where oo.object_id = p_object_id
                    and oo.role in ('owner', 'co_owner', 'proxy')) then
    raise exception 'INVARIANT_32: у объекта нет собственника, договор заключать не с кем'
      using errcode = 'check_violation';
  end if;

  insert into mandates (object_id, kind, valid_to, start_price,
                        listing_agent_id, contract_confirmed, status)
  values (p_object_id, p_kind, p_valid_to,
          coalesce(p_start_price, o.price), v_agent, p_confirmed, 'active')
  returning * into r;

  return r;
end $$;

comment on function sign_mandate is
  'Инвариант 32. Заключает договор по уже заведённому объекту. Действующий договор у объекта один — второй отклонит mandates_one_active_per_object_idx.';

create or replace function confirm_mandate(p_object_id uuid)
  returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r mandates;
begin
  perform app.require_agent();

  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_32: договор подтверждает агент этого договора'
      using errcode = '42501';
  end if;

  update mandates set contract_confirmed = true
   where object_id = p_object_id and status = 'active'
  returning * into r;

  if r.id is null then
    raise exception 'INVARIANT_32: у объекта нет действующего договора'
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function confirm_mandate is
  'Инвариант 32. «Объект взят в работу» — это подписанный договор, и отмечает его тот, кто договор ведёт.';

-- ---------------------------------------------------------------------------
-- Воронка объекта
-- ---------------------------------------------------------------------------
-- Колонка выводится: ранние этапы из owner_stage, дальше — из фактов. Своего
-- поля «колонка» у объекта нет, расходиться с работой нечему (инвариант 30).

create or replace function app.listing_stage(p_object_id uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    -- Сделка сильнее всего: по объекту уже идут деньги.
    when exists (select 1 from deals d
                  join matches m on m.id = d.match_id
                 where m.object_id = p_object_id and d.status = 'closed')
                                                              then 'sold'
    when exists (select 1 from deals d
                  join matches m on m.id = d.match_id
                 where m.object_id = p_object_id
                   and d.status not in ('closed', 'failed'))   then 'in_deal'

    -- А вот дальше порядок важнее, чем кажется, и первая версия его
    -- перепутала. «Нет подписанного договора» идёт ВЫШЕ публикации: объект,
    -- который рекламируют на честном слове, — это и есть риск, ради
    -- которого воронка объектов существует. Пока проверка публикации стояла
    -- раньше, такой объект показывался в колонке «В рекламе», и то, что
    -- договора нет, из воронки исчезало.
    when exists (select 1 from mandates md
                  where md.object_id = p_object_id and md.status = 'active'
                    and not md.contract_confirmed)             then 'no_contract'

    when (select o.publication_state from objects o where o.id = p_object_id)
         = 'published'                                        then 'advertised'
    when exists (select 1 from mandates md
                  where md.object_id = p_object_id and md.status = 'active')
                                                              then 'contracted'
    else (select o.owner_stage::text from objects o where o.id = p_object_id)
  end
$$;

comment on function app.listing_stage is
  'Инвариант 32. Колонка воронки объекта. Ранние этапы — решения агента, дальше — факты: договор, подпись, публикация, сделка.';

create or replace function app.listing_stage_days(p_stage text) returns integer
  language sql immutable as $$
  select case p_stage
    -- Заведённый и не обзвоненный объект устаревает быстрее всего: по
    -- объявлению недельной давности собственник уже устал от звонков.
    when 'new'         then 2
    when 'called'      then 5
    when 'visited'     then 7
    -- Работа без договора не должна длиться вечно: это и есть риск.
    when 'no_contract' then 14
    -- Договор есть, а объявления нет — объект простаивает.
    when 'contracted'  then 3
    else null
  end
$$;

-- Дата входа В ЭТУ колонку, а не «последнее что-нибудь». Первая версия брала
-- greatest(owner_stage_since, created_at) и получала у объекта без договора
-- всегда «сегодня»: created_at перебивал сдвинутую назад дату этапа, и
-- вставших карточек не бывало вовсе.
create or replace function app.listing_stage_since(p_object_id uuid)
  returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
  select case app.listing_stage(p_object_id)
    when 'new'         then o.owner_stage_since
    when 'called'      then o.owner_stage_since
    when 'visited'     then o.owner_stage_since
    when 'no_contract' then md.created_at
    when 'contracted'  then md.updated_at
    when 'advertised'  then coalesce(o.published_at, md.updated_at, o.updated_at)
    else o.updated_at
  end
  from objects o
  left join mandates md on md.object_id = o.id and md.status = 'active'
  where o.id = p_object_id
$$;

comment on function app.listing_stage_since is
  'Инвариант 32. Когда объект попал в текущую колонку воронки. У каждой колонки своя дата: этап работы с собственником, дата договора, дата публикации.';

create or replace view listing_funnel_v
  with (security_invoker = true) as
select
  o.id                       as object_id,
  o.address,
  o.kind,
  o.deal_type,
  o.zone,
  o.rooms,
  o.price,
  o.currency,
  o.publication_state,
  o.actual_at,
  o.owner_stage,
  o.owner_stage_since,
  app.listing_stage(o.id)    as stage,
  md.id                      as mandate_id,
  md.kind                    as mandate_kind,
  md.contract_confirmed,
  md.valid_to,
  md.listing_agent_id,
  a.full_name                as listing_agent_name,
  coalesce(md.listing_agent_id, o.created_by_agent_id) as owner_agent_id,
  -- Имя ведущего агента, а не только того, у кого договор: до договора объект
  -- ведёт тот, кто его завёл, и в фильтре руководителя он должен быть назван,
  -- а не висеть как «без имени».
  coalesce(a.full_name, ca.full_name)                  as owner_agent_name,
  c.name                     as owner_name,
  app.listing_stage_since(o.id) as stage_since,
  extract(day from now() - app.listing_stage_since(o.id))::int as days_in_stage,
  app.listing_stage_days(app.listing_stage(o.id)) as stage_limit_days,
  (app.listing_stage_days(app.listing_stage(o.id)) is not null
   and app.listing_stage_since(o.id)
       < now() - make_interval(days => app.listing_stage_days(app.listing_stage(o.id)))) as stuck,
  (select count(*) from showings s join matches m on m.id = s.match_id
    where m.object_id = o.id and s.status = 'done')::int as showings_done
from objects o
left join mandates md on md.object_id = o.id and md.status = 'active'
left join agents a    on a.id = md.listing_agent_id
left join agents ca   on ca.id = o.created_by_agent_id
left join object_ownerships oo on oo.object_id = o.id and oo.role = 'owner'
left join contacts c  on c.id = oo.contact_id;

comment on view listing_funnel_v is
  'Инвариант 32. Воронка объектов: докуда дошла работа с собственником. Тип договора и «подписан ли» здесь видны всем агентам — это и есть ответ на вопрос «получу ли я комиссию по чужому объекту».';

-- ---------------------------------------------------------------------------
-- Переходы ранних этапов
-- ---------------------------------------------------------------------------

create or replace function set_owner_stage(p_object_id uuid, p_stage owner_stage)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r objects;
begin
  update objects set owner_stage = p_stage
   where id = p_object_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function set_owner_stage is
  'Инвариант 32. «Позвонили» и «съездили» — решения агента, и ставит их он. Назад не ходят.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.touch_owner_stage(),
  app.check_owner_stage(),
  app.listing_stage(uuid),
  app.listing_stage_since(uuid),
  app.listing_stage_days(text),
  register_object(object_kind, deal_type, text, numeric, uuid, text, text, text,
                  smallint, numeric, smallint, smallint, text, text, uuid),
  sign_mandate(uuid, mandate_kind, date, numeric, boolean),
  confirm_mandate(uuid),
  set_owner_stage(uuid, owner_stage)
  from public;

grant execute on function
  app.listing_stage(uuid),
  app.listing_stage_since(uuid),
  app.listing_stage_days(text),
  register_object(object_kind, deal_type, text, numeric, uuid, text, text, text,
                  smallint, numeric, smallint, smallint, text, text, uuid),
  sign_mandate(uuid, mandate_kind, date, numeric, boolean),
  confirm_mandate(uuid),
  set_owner_stage(uuid, owner_stage)
  to authenticated;

grant select on listing_funnel_v to authenticated;
revoke all on listing_funnel_v from anon;
