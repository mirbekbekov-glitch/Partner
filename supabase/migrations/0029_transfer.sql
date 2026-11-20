-- 0029_transfer.sql
-- ИНВАРИАНТ 23: передача клиента или объекта — одно действие. Незакрытая
--               работа переходит вместе с ними, закрытые сделки не меняют
--               сторон никогда.
--
-- Зачем. Правило «ведёт тот, кто ведёт» уже есть везде — инварианты 20 и 22
-- закрыли возможность работать по чужому клиенту и править чужой объект. А
-- способа передать не было вовсе. В первый же отпуск или увольнение это
-- означает одно из двух: либо работа встаёт, либо кто-то лезет в базу руками.
--
-- ЧТО ПЕРЕХОДИТ. Передача объекта — это смена владельца действующего
-- договора. Вместе с ним переходит листинговая сторона НЕЗАКРЫТЫХ сделок:
-- комиссия по ним ещё не зафиксирована, и получит её тот, кто доведёт дело
-- до конца. Передача клиента — смена агента потребности, а вместе с ней
-- закрывающая сторона его подборов и незакрытых сделок.
--
-- ЧТО НЕ ПЕРЕХОДИТ НИКОГДА. Закрытые и сорванные сделки. Там комиссия уже
-- посчитана и записана (инвариант 3), и менять в них стороны значит менять,
-- кому заплачено. Это запрещено даже администратору.

-- ---------------------------------------------------------------------------
-- Сначала — уточнение инварианта 3
-- ---------------------------------------------------------------------------
-- app.check_deal_from_match() сверял стороны сделки с ТЕКУЩИМ владельцем
-- мандата — и на insert это правильно, а на update оказывается ловушкой:
-- после передачи объекта все прошлые сделки по нему перестают сходиться с
-- мандатом, и любое обращение к ним падает. То есть передача делала историю
-- неизменяемой задним числом.
--
-- Правило на самом деле другое: стороны БЕРУТСЯ из мандата и подбора при
-- заведении сделки и не переписываются из запроса. На update это значит
-- «либо те же, либо те, что стали у мандата и подбора», а не «вечно равны
-- текущим».

create or replace function app.check_deal_from_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m         matches%rowtype;
  v_mandate mandates%rowtype;
begin
  select * into m from matches where id = new.match_id;
  if not found then
    raise exception 'INVARIANT_2: подбор % не найден', new.match_id
      using errcode = 'no_data_found';
  end if;

  if new.object_id <> m.object_id then
    raise exception 'INVARIANT_2: объект сделки % не совпадает с объектом подбора %',
      new.object_id, m.object_id using errcode = 'check_violation';
  end if;

  if new.requirement_id <> m.requirement_id then
    raise exception 'INVARIANT_2: потребность сделки % не совпадает с потребностью подбора %',
      new.requirement_id, m.requirement_id using errcode = 'check_violation';
  end if;

  select * into v_mandate from mandates where id = new.mandate_id;
  if v_mandate.object_id <> m.object_id then
    raise exception 'INVARIANT_2: мандат % выдан на другой объект', new.mandate_id
      using errcode = 'check_violation';
  end if;

  -- Инвариант 3: стороны комиссии берутся из мандата и подбора, а не из
  -- запроса. На правке допустимо одно из двух: не менять их вовсе или
  -- привести к тому, что стало у мандата и подбора, — это и есть передача.
  if tg_op = 'INSERT' or new.listing_agent_id is distinct from old.listing_agent_id then
    if new.listing_agent_id <> v_mandate.listing_agent_id then
      raise exception 'INVARIANT_3: listing_agent сделки должен совпадать с listing_agent мандата (%)',
        v_mandate.listing_agent_id using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' or new.closing_agent_id is distinct from old.closing_agent_id then
    if new.closing_agent_id <> m.closing_agent_id then
      raise exception 'INVARIANT_3: closing_agent сделки должен совпадать с closing_agent подбора (%)',
        m.closing_agent_id using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

comment on function app.check_deal_from_match is
  'Инварианты 2 и 3. Стороны сделки берутся из мандата и подбора при заведении и вручную не переписываются. Передача (инвариант 23) приводит их к новым.';

-- ---------------------------------------------------------------------------
-- Закрытая сделка не меняет сторон
-- ---------------------------------------------------------------------------
-- Инвариант 21 замораживал цену, комиссию и статус, но не стороны. А сторона
-- закрытой сделки — это ответ на вопрос «кому заплачено», и он не менее
-- важен, чем сумма.

create or replace function app.check_deal_lifecycle() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_me uuid := app.current_agent_id();
begin
  if auth.uid() is not null and not app.is_admin() then
    if tg_op = 'INSERT' then
      if v_me is distinct from new.listing_agent_id
         and v_me is distinct from new.closing_agent_id then
        raise exception 'INVARIANT_21: сделку заводит её участник'
          using errcode = '42501';
      end if;
    else
      if v_me is distinct from old.listing_agent_id
         and v_me is distinct from old.closing_agent_id then
        raise exception 'INVARIANT_21: сделку ведут её участники'
          using errcode = '42501',
                hint = 'Это сделка другого агента.';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if old.status = 'closed' then
    if new.status is distinct from old.status then
      raise exception 'INVARIANT_21: закрытая сделка не меняет состояние (попытка «%»)', new.status
        using errcode = 'check_violation';
    end if;
    if new.final_price      is distinct from old.final_price
       or new.commission_total is distinct from old.commission_total
       or new.listing_share    is distinct from old.listing_share
       or new.closing_share    is distinct from old.closing_share
       or new.closed_at        is distinct from old.closed_at then
      raise exception 'INVARIANT_21: цена и комиссия закрытой сделки неизменны'
        using errcode = 'check_violation',
              hint = 'Если сумма была записана неверно, это исправляется новой сделкой, а не правкой старой.';
    end if;
  end if;

  -- Стороны закрытой и сорванной сделки — ответ на вопрос «кому заплачено».
  -- Передача (инвариант 23) двигает только незакрытую работу.
  if old.status in ('closed', 'failed')
     and (new.listing_agent_id is distinct from old.listing_agent_id
          or new.closing_agent_id is distinct from old.closing_agent_id) then
    raise exception 'INVARIANT_23: стороны закрытой сделки не меняются: это ответ на вопрос, кому заплачено'
      using errcode = 'check_violation';
  end if;

  if old.status = 'failed' and new.status is distinct from old.status then
    raise exception 'INVARIANT_21: сорванную сделку не закрыть задним числом'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Кому можно передавать
-- ---------------------------------------------------------------------------

create or replace function app.check_transfer_target(p_to_agent uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status agent_status;
begin
  if p_to_agent = app.current_agent_id() then
    raise exception 'INVARIANT_23: передавать самому себе незачем'
      using errcode = 'invalid_parameter_value';
  end if;

  select status into v_status from agents where id = p_to_agent;
  if v_status is null then
    raise exception 'INVARIANT_23: агент % не существует', p_to_agent
      using errcode = 'no_data_found';
  end if;
  if v_status <> 'approved' then
    raise exception 'INVARIANT_23: передавать можно только действующему агенту (у этого статус «%»)', v_status
      using errcode = 'check_violation',
            hint = 'Неодобренный или заблокированный агент работать не может, и отданная ему работа встанет.';
  end if;
end $$;

comment on function app.check_transfer_target is
  'Инвариант 23. Кому можно передать работу: действующему агенту и не себе.';

-- ---------------------------------------------------------------------------
-- Передача объекта
-- ---------------------------------------------------------------------------

create or replace function transfer_object(p_object_id uuid, p_to_agent uuid)
  returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me      uuid := app.require_agent();
  v_mandate mandates;
  r         mandates;
begin
  select * into v_mandate from mandates
   where object_id = p_object_id and status = 'active';

  if v_mandate.id is null then
    raise exception 'INVARIANT_23: у объекта нет действующего договора, передавать нечего'
      using errcode = 'no_data_found',
            hint = 'Объект без договора ведёт тот, кто его завёл.';
  end if;

  if v_mandate.listing_agent_id <> v_me and not app.is_admin() then
    raise exception 'INVARIANT_23: объект передаёт тот, кто его ведёт, или администратор'
      using errcode = '42501';
  end if;

  perform app.check_transfer_target(p_to_agent);

  update mandates set listing_agent_id = p_to_agent
   where id = v_mandate.id
  returning * into r;

  -- Незакрытая работа переходит вместе с объектом: комиссия по таким сделкам
  -- ещё не зафиксирована, и получит её тот, кто доведёт дело до конца.
  -- Закрытые и сорванные не трогаем — там уже сказано, кому заплачено.
  update deals set listing_agent_id = p_to_agent
   where mandate_id = v_mandate.id
     and status not in ('closed', 'failed');

  return r;
end $$;

comment on function transfer_object is
  'Инвариант 23. Передаёт объект другому агенту вместе с незакрытыми сделками. Закрытые не трогает.';

-- ---------------------------------------------------------------------------
-- Передача клиента
-- ---------------------------------------------------------------------------

create or replace function transfer_requirement(p_requirement_id uuid, p_to_agent uuid)
  returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me  uuid := app.require_agent();
  v_req requirements;
  r     requirements;
begin
  select * into v_req from requirements where id = p_requirement_id;

  if v_req.id is null then
    raise exception 'потребность % не найдена', p_requirement_id
      using errcode = 'no_data_found';
  end if;

  if v_req.agent_id <> v_me and not app.is_admin() then
    raise exception 'INVARIANT_23: клиента передаёт тот, кто его ведёт, или администратор'
      using errcode = '42501';
  end if;

  perform app.check_transfer_target(p_to_agent);

  update requirements set agent_id = p_to_agent
   where id = p_requirement_id
  returning * into r;

  -- Подборы клиента переходят вместе с ним: иначе инвариант 20 оставит
  -- прежнего агента закрывающей стороной, и работать по ним новый не сможет.
  --
  -- Кроме тех, за которыми стоит закрытая или сорванная сделка. Такой подбор
  -- — история: сделка по нему уже записала, кто её вёл и кому заплачено, и
  -- переписывать подбор значит расходиться с этой записью. Первая версия
  -- двигала все подборы подряд.
  update matches mt set closing_agent_id = p_to_agent
   where mt.requirement_id = p_requirement_id
     and not exists (select 1 from deals d
                      where d.match_id = mt.id
                        and d.status in ('closed', 'failed'));

  update deals set closing_agent_id = p_to_agent
   where requirement_id = p_requirement_id
     and status not in ('closed', 'failed');

  return r;
end $$;

comment on function transfer_requirement is
  'Инвариант 23. Передаёт клиента другому агенту вместе с подборами и незакрытыми сделками.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function app.check_transfer_target(uuid) from public;
revoke execute on function
  transfer_object(uuid, uuid), transfer_requirement(uuid, uuid) from public;
grant execute on function
  transfer_object(uuid, uuid), transfer_requirement(uuid, uuid) to authenticated;
