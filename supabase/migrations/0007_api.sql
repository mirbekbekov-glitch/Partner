-- 0007_api.sql
-- Слой доступа. Единственные пути изменения состояния, которые кабинет должен
-- вызывать. Триггеры из 0005 держат инварианты даже при прямом UPDATE, но
-- через эти функции клиенту физически нечего передать неправильно:
-- стороны комиссии, мандат и ссылки выводятся на сервере, а не приходят в запросе.

-- ---------------------------------------------------------------------------
-- Публикация объекта
-- ---------------------------------------------------------------------------

create or replace function publish_object(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if app.active_mandate_id(p_object_id) is null then
    raise exception
      'INVARIANT_1: объект нельзя опубликовать без активного мандата'
      using errcode = 'check_violation',
            hint = 'Заключите мандат с собственником, затем публикуйте.';
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

  update objects set publication_state = 'withdrawn'
   where id = p_object_id returning * into r;

  update publication_channels
     set status = 'withdrawn', last_sync_at = now()
   where object_id = p_object_id and status in ('exported', 'updated');

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Подбор
-- ---------------------------------------------------------------------------
-- closing_agent — тот, кто ведёт клиента, то есть текущий агент. Передать
-- чужого нельзя: инвариант 3 опирается на это поле.

create or replace function create_match(
  p_object_id      uuid,
  p_requirement_id uuid
) returns matches
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_obj   objects%rowtype;
  v_req   requirements%rowtype;
  r       matches;
begin
  select * into v_obj from objects where id = p_object_id;
  if not found then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  select * into v_req from requirements where id = p_requirement_id;
  if not found then
    raise exception 'потребность % не найдена', p_requirement_id using errcode = 'no_data_found';
  end if;

  -- Аренду не подбирают под покупку.
  if v_obj.deal_type <> v_req.deal_type then
    raise exception 'подбор невозможен: объект это %, потребность это %',
      v_obj.deal_type, v_req.deal_type using errcode = 'check_violation';
  end if;

  if v_req.status in ('closed', 'lost') then
    raise exception 'потребность закрыта, подбор невозможен'
      using errcode = 'check_violation';
  end if;

  insert into matches (object_id, requirement_id, closing_agent_id, created_by_agent_id)
  values (p_object_id, p_requirement_id, v_agent, v_agent)
  on conflict (object_id, requirement_id) do nothing
  returning * into r;

  if r.id is null then
    select * into r from matches
     where object_id = p_object_id and requirement_id = p_requirement_id;
  end if;
  return r;
end $$;

comment on function create_match is
  'Единственный путь создания подбора. closing_agent всегда текущий агент — на этом держится инвариант 3.';

-- ---------------------------------------------------------------------------
-- Сделка из подбора (инвариант 2)
-- ---------------------------------------------------------------------------
-- Все ссылки и обе стороны комиссии выводятся из подбора и активного мандата.
-- Клиент передаёт только match_id: подменить listing_agent невозможно.

create or replace function create_deal_from_match(p_match_id uuid)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  m         matches%rowtype;
  v_mandate uuid;
  v_listing uuid;
  r         deals;
begin
  select * into m from matches where id = p_match_id;
  if not found then
    raise exception 'INVARIANT_2: подбор % не найден', p_match_id
      using errcode = 'no_data_found';
  end if;

  if m.status = 'rejected' then
    raise exception 'INVARIANT_2: сделка из отклонённого подбора невозможна'
      using errcode = 'check_violation';
  end if;

  v_mandate := app.active_mandate_id(m.object_id);
  if v_mandate is null then
    raise exception 'INVARIANT_1: у объекта нет активного мандата, сделка невозможна'
      using errcode = 'check_violation';
  end if;

  select listing_agent_id into v_listing from mandates where id = v_mandate;

  insert into deals (
    match_id, object_id, requirement_id, mandate_id,
    listing_agent_id, closing_agent_id, status
  ) values (
    m.id, m.object_id, m.requirement_id, v_mandate,
    v_listing, m.closing_agent_id, 'deposit'
  ) returning * into r;

  update matches     set status = 'in_deal' where id = m.id;
  update requirements set status = 'in_deal' where id = m.requirement_id;

  return r;
end $$;

comment on function create_deal_from_match is
  'Инвариант 2: единственный путь создания сделки. Принимает только match_id, остальное выводит сам.';

-- ---------------------------------------------------------------------------
-- Закрытие и срыв сделки
-- ---------------------------------------------------------------------------

create or replace function close_deal(p_deal_id uuid, p_final_price numeric)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if p_final_price is null or p_final_price <= 0 then
    raise exception 'финальная цена обязательна для закрытия сделки'
      using errcode = 'check_violation';
  end if;

  -- Комиссию, мандат и потребность закрывает триггер e_deal_closed (0005):
  -- правило одно и работает даже при прямом UPDATE.
  update deals
     set status = 'closed', final_price = p_final_price, closed_at = now()
   where id = p_deal_id
  returning * into r;

  if r.id is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;

  -- Триггер дописал суммы уже после RETURNING, поэтому перечитываем.
  select * into r from deals where id = p_deal_id;
  return r;
end $$;

create or replace function fail_deal(p_deal_id uuid, p_reason text)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'причина срыва обязательна' using errcode = 'check_violation';
  end if;

  update deals set status = 'failed', failure_reason = p_reason
   where id = p_deal_id returning * into r;

  -- Потребность возвращается в работу: сделка сорвалась, клиент остался.
  update requirements set status = 'qualified'
   where id = r.requirement_id and status = 'in_deal';

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Перенос существующих объектов (пункт 3 порядка работ)
-- ---------------------------------------------------------------------------
-- На чистой базе переносить нечего, но путь импорта нужен и сейчас: любой
-- объект, попавший в базу без мандата, обязан его получить, иначе инвариант 1
-- сделает его невидимым.
--
-- Решение по согласованию: мандат создаётся АКТИВНЫМ с contract_confirmed = false.
-- Каталог не падает, а неподтверждённые договоры видны отдельным флагом.
-- Ни одно поле объекта не меняется.

create or replace function app.backfill_missing_mandates()
  returns table (object_id uuid, mandate_id uuid)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  insert into mandates (
    object_id, kind, valid_from, valid_to, start_price,
    listing_agent_id, contract_confirmed, status
  )
  select
    o.id,
    'non_exclusive',
    coalesce(o.published_at::date, o.created_at::date, current_date),
    null,                      -- срок не выдумываем, уточняется при подтверждении
    o.price,                   -- стартовая цена = текущая, поле объекта не трогаем
    o.created_by_agent_id,     -- текущий агент сохраняется
    false,                     -- договор требует подтверждения
    'active'                   -- но каталог продолжает работать
  from objects o
  where not exists (select 1 from mandates m where m.object_id = o.id)
  returning mandates.object_id, mandates.id;
end $$;

comment on function app.backfill_missing_mandates is
  'Пункт 3: каждому объекту без мандата — активный мандат с contract_confirmed=false. Поля объекта не меняются, агент сохраняется.';

grant execute on function
  publish_object(uuid), withdraw_object(uuid),
  create_match(uuid, uuid), create_deal_from_match(uuid),
  close_deal(uuid, numeric), fail_deal(uuid, text)
  to authenticated;
