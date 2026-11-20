-- 0026_matching.sql
-- ИНВАРИАНТ 20: агент подбора — это агент потребности, он не назначается
--               запросом; объект без действующего договора клиенту не
--               предлагают.
--
-- Обе половины найдены запросом, а не рассуждением, и обе оказались дырами.
--
-- ПЕРВАЯ. create_match() ставил closing_agent_id = вызывающий. Значит любой
-- агент мог подобрать объект по ЧУЖОЙ потребности и стать по ней агентом
-- подбора. А доля агента покупателя по инварианту 3 считается именно по
-- closing_agent_id — то есть это не беспорядок в данных, это чужие деньги.
-- Проверено: Чынгыз завёл подбор по клиенту Бакыта и стал агентом подбора.
--
-- Чинится не проверкой, а выводом: агент подбора НЕ ПРИНИМАЕТСЯ в запросе,
-- он берётся из потребности. Поле, которое нельзя передать неправильно,
-- надёжнее поля, которое проверяется.
--
-- ВТОРАЯ. Подбор не смотрел на договор вовсе. Объект, у которого мандат
-- истёк или расторгнут, предлагался клиенту как ни в чём не бывало. Это тот
-- же инвариант 1, но с другой стороны: в каталог такой объект не попадёт, а
-- показать его клиенту лично никто не мешал.
--
-- Снятый с публикации объект с ДЕЙСТВУЮЩИМ договором предлагать можно и
-- нужно: эксклюзив часто не рекламируют, а показывают. Правило про договор,
-- а не про витрину.
--
-- Оба правила стоят в триггере, а не в функции: роли приложения выдан insert
-- на matches, и правило, живущее только в функции, обходится прямой вставкой.

create or replace function app.check_match_rules() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_req_agent uuid;
begin
  select agent_id into v_req_agent from requirements where id = new.requirement_id;
  if v_req_agent is null then
    raise exception 'INVARIANT_20: потребность % не существует', new.requirement_id
      using errcode = 'no_data_found';
  end if;

  -- Агент подбора выводится, а не принимается. Передать чужого нельзя не
  -- потому, что это проверяется, а потому, что это поле не читается.
  new.closing_agent_id := v_req_agent;

  -- Вести подбор по чужому клиенту нельзя. Правило касается запросов из
  -- приложения: у миграций и переносов входа нет, и притворяться, что
  -- триггер их останавливает, незачем.
  if auth.uid() is not null
     and not app.is_admin()
     and v_req_agent is distinct from app.current_agent_id() then
    raise exception 'INVARIANT_20: подбор по потребности ведёт её агент'
      using errcode = '42501',
            hint = 'Попросите коллегу подобрать самому или передать клиента.';
  end if;

  -- Договор. Объект без действующего мандата агентство предлагать не вправе:
  -- у него нет на это договора с собственником.
  if not exists (select 1 from mandates m
                  where m.object_id = new.object_id and m.status = 'active') then
    raise exception 'INVARIANT_20: у объекта нет действующего договора, предлагать его нельзя'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function app.check_match_rules is
  'Инвариант 20. Агент подбора выводится из потребности; объект без действующего договора клиенту не предлагается.';

create trigger b_match_rules
  before insert on matches
  for each row execute function app.check_match_rules();

-- ---------------------------------------------------------------------------
-- Потребность клиента
-- ---------------------------------------------------------------------------
-- Та же мысль, что у create_object: клиент и его потребность — один разговор.
-- contact_id у потребности и так NOT NULL, поэтому речь не о запрете, а о
-- том, чтобы завести клиента и потребность одним действием, не разводя
-- одного человека по двум карточкам.

create or replace function create_requirement(
  p_deal_type    deal_type,
  p_contact_id   uuid    default null,
  p_client_name  text    default null,
  p_client_phone text    default null,
  p_budget_min   numeric default null,
  p_budget_max   numeric default null,
  p_zones        text[]  default '{}',
  p_rooms        smallint[] default '{}',
  p_deadline     date    default null,
  p_text         text    default null,
  -- Если потребность родилась из обращения, оно закрывается тем же вызовом.
  p_inquiry_id   uuid    default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_contact_id;
  v_phone   text := nullif(btrim(coalesce(p_client_phone, '')), '');
  r         requirements;
begin
  if v_contact is null and v_phone is null then
    raise exception 'INVARIANT_20: у потребности должен быть клиент: укажите контакт или имя с телефоном'
      using errcode = 'not_null_violation';
  end if;

  if v_contact is not null then
    if not app.can_see_contact(v_contact) then
      raise exception 'FORBIDDEN: этот контакт вам не виден'
        using errcode = '42501';
    end if;
  else
    -- Тот же номер — тот же человек: клиент, который ищет вторую квартиру,
    -- не должен превращаться во второго клиента.
    select cp.contact_id into v_contact
      from contact_phones cp
     where cp.phone = coalesce(app.normalize_phone(v_phone), v_phone)
     limit 1;

    if v_contact is null then
      if nullif(btrim(coalesce(p_client_name, '')), '') is null then
        raise exception 'INVARIANT_20: у нового клиента должно быть имя'
          using errcode = 'not_null_violation';
      end if;

      insert into contacts (name, roles, owner_agent_id, source)
      values (btrim(p_client_name), array['buyer']::contact_role[], v_agent,
              case when p_inquiry_id is not null then 'обращение'
                   else 'заведён при создании потребности' end)
      returning id into v_contact;

      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, v_phone, true);
    end if;
  end if;

  insert into requirements (contact_id, deal_type, budget_min, budget_max,
                            zones, rooms, deadline, requirements_text, agent_id)
  values (v_contact, p_deal_type, p_budget_min, p_budget_max,
          coalesce(p_zones, '{}'), coalesce(p_rooms, '{}'), p_deadline,
          nullif(btrim(coalesce(p_text, '')), ''), v_agent)
  returning * into r;

  if p_inquiry_id is not null then
    perform convert_inquiry(p_inquiry_id, r.id, null);
  end if;

  return r;
end $$;

comment on function create_requirement is
  'Инвариант 20. Заводит потребность вместе с клиентом одним действием. При p_inquiry_id закрывает обращение.';

-- ---------------------------------------------------------------------------
-- Сам подбор
-- ---------------------------------------------------------------------------
-- Чего не было вовсе: поиска. object_matches_v и requirement_matches_v
-- показывают УЖЕ сделанные подборы, а подобрать было нечем — агент смотрел
-- каталог глазами.
--
-- Правила отбора ровно те, что человек проговаривает вслух: тот же тип
-- сделки, в бюджет, в нужном районе, с нужным числом комнат. Всё, чего
-- клиент не назвал, ограничением не считается: пустой список районов
-- означает «любой», а не «никакой».
--
-- «Чуть дороже» — отдельная пометка, а не выбрасывание. Объект на 10% выше
-- потолка агент показывает сознательно, и прятать его от агента значит
-- решать за него.

create or replace function app.matching_objects(p_requirement_id uuid)
  returns table (
    object_id      uuid,
    address        text,
    kind           object_kind,
    zone           text,
    rooms          smallint,
    area           numeric,
    floor          smallint,
    floors_total   smallint,
    price          numeric,
    currency       text,
    actual_at      timestamptz,
    publication_state publication_state,
    photos_count   integer,
    listing_agent  text,
    is_mine        boolean,
    fit            text,
    already_proposed boolean
  )
  language sql stable security invoker set search_path = public, pg_temp as $$
  with req as (
    select * from requirements where id = p_requirement_id
  )
  select
    o.id, o.address, o.kind, o.zone, o.rooms, o.area, o.floor, o.floors_total,
    o.price, o.currency::text, o.actual_at, o.publication_state,
    (select count(*)::integer from object_photos p where p.object_id = o.id),
    la.full_name,
    (m.listing_agent_id = app.current_agent_id()),
    case
      when req.budget_max is not null and o.price > req.budget_max then 'чуть дороже'
      else 'подходит'
    end,
    exists (select 1 from matches mt
             where mt.object_id = o.id and mt.requirement_id = req.id)
  from req
  join objects o
    on o.deal_type = req.deal_type
   -- Договор: без него предлагать нечего, и подбор об этом знает заранее,
   -- а не узнаёт отказом при попытке.
  join mandates m
    on m.object_id = o.id and m.status = 'active'
  left join agents la on la.id = m.listing_agent_id
  where
    (req.budget_min is null or o.price >= req.budget_min)
    -- Потолок не отрезает сразу: то, что выше на десятую часть, приходит
    -- с пометкой.
    and (req.budget_max is null or o.price <= req.budget_max * 1.1)
    and (cardinality(req.zones) = 0 or o.zone = any (req.zones))
    and (cardinality(req.rooms) = 0 or o.rooms = any (req.rooms))
  order by
    -- Сначала то, что точно в бюджет, потом «чуть дороже».
    (req.budget_max is not null and o.price > req.budget_max),
    -- Внутри — по свежести подтверждения: несвежее объявление тратит время
    -- клиента и портит показ.
    o.actual_at desc
  limit 100
$$;

comment on function app.matching_objects is
  'Инвариант 20. Подбор объектов под потребность: тот же тип сделки, бюджет, район, комнаты, действующий договор. Права — вызывающего.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function app.check_match_rules() from public;
revoke execute on function app.matching_objects(uuid) from public;
revoke execute on function create_requirement(
  deal_type, uuid, text, text, numeric, numeric, text[], smallint[], date, text, uuid)
  from public;

grant execute on function app.matching_objects(uuid) to authenticated;
grant execute on function create_requirement(
  deal_type, uuid, text, text, numeric, numeric, text[], smallint[], date, text, uuid)
  to authenticated;
