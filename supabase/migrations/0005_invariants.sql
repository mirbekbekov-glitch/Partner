-- 0005_invariants.sql
-- Серверные проверки инвариантов 1, 2, 5. Проверяется в базе, не в UI:
-- PostgREST, psql и фоновые задания обойти эти правила не могут.

-- ---------------------------------------------------------------------------
-- Активный мандат объекта
-- ---------------------------------------------------------------------------
-- Единственность гарантирует partial unique index из 0002, поэтому здесь
-- достаточно обычного select без агрегата.

create or replace function app.active_mandate_id(p_object_id uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.id from mandates m
   where m.object_id = p_object_id and m.status = 'active'
$$;

-- ===========================================================================
-- ИНВАРИАНТ 1. Публикация только при активном мандате.
-- ===========================================================================

create or replace function app.check_object_publication() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.publication_state = 'published'
     and app.active_mandate_id(new.id) is null then
    raise exception
      'INVARIANT_1: объект % не может быть опубликован без активного мандата', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- AFTER, а не BEFORE: на INSERT мандат физически не может существовать до
-- появления строки объекта, поэтому проверять надо после вставки, в той же
-- транзакции. Объект создаётся как draft, публикуется отдельным шагом.
create constraint trigger c_objects_publication_requires_mandate
  after insert or update of publication_state on objects
  deferrable initially immediate
  for each row execute function app.check_object_publication();

-- Выгрузка в канал — тоже публикация, и правило то же.
create or replace function app.check_channel_publication() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('exported', 'updated')
     and app.active_mandate_id(new.object_id) is null then
    raise exception
      'INVARIANT_1: объект % не может быть выгружен в канал % без активного мандата',
      new.object_id, new.channel
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger c_channels_require_mandate
  before insert or update of status on publication_channels
  for each row execute function app.check_channel_publication();

-- Обратная сторона инварианта 1. Без неё истёкший или расторгнутый мандат
-- оставил бы объект опубликованным, и инвариант держался бы только на входе.
create or replace function app.withdraw_on_mandate_release() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_object uuid := coalesce(old.object_id, new.object_id);
begin
  -- Мандат перестал быть активным (сменил статус или удалён).
  if tg_op = 'DELETE' or (old.status = 'active' and new.status <> 'active') then
    if app.active_mandate_id(v_object) is null then
      update objects
         set publication_state = 'withdrawn'
       where id = v_object
         and publication_state = 'published';

      update publication_channels
         set status = 'withdrawn', last_sync_at = now()
       where object_id = v_object
         and status in ('exported', 'updated');
    end if;
  end if;
  return null;
end $$;

create trigger d_mandate_release_withdraws_object
  after update of status or delete on mandates
  for each row execute function app.withdraw_on_mandate_release();

-- Мандат нельзя создать активным с уже истёкшим сроком.
create or replace function app.check_mandate_validity() returns trigger
  language plpgsql as $$
begin
  -- Проверяется АКТИВАЦИЯ, а не любая правка активного мандата. Сократить
  -- срок уже действующего договора — обычное дело («расходимся с прошлой
  -- недели»); такой мандат должен затем погасить app.expire_mandates().
  -- Если проверять каждый UPDATE, запись о закончившемся сроке становится
  -- невозможной, и мандат нельзя ни закрыть по дате, ни отредактировать.
  if (tg_op = 'INSERT' or old.status <> 'active')
     and new.status = 'active'
     and new.valid_to is not null
     and new.valid_to < current_date then
    raise exception
      'INVARIANT_1: мандат нельзя активировать со сроком до %', new.valid_to
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_mandate_validity
  before insert or update on mandates
  for each row execute function app.check_mandate_validity();

-- Истечение по дате. Запускать по расписанию (pg_cron / Supabase scheduled
-- function). Смена статуса каскадом снимает объекты с публикации выше.
create or replace function app.expire_mandates() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  with e as (
    update mandates
       set status = 'expired'
     where status = 'active'
       and valid_to is not null
       and valid_to < current_date
    returning 1
  ) select count(*) into v_count from e;
  return v_count;
end $$;

comment on function app.expire_mandates is
  'Инвариант 1: истечение мандата по дате. Обязателен вызов по расписанию, иначе объект остаётся опубликованным с просроченным договором.';

-- ===========================================================================
-- ИНВАРИАНТ 2. Сделка только из подбора. Закрытие закрывает мандат и потребность.
-- ===========================================================================

-- match_id NOT NULL в 0002 запрещает сделку без подбора. Здесь сверяется,
-- что денормализованные ссылки не расходятся с подбором и мандатом —
-- иначе «сделка из подбора» выполнялась бы формально, а поля указывали бы
-- на чужой объект.
create or replace function app.check_deal_from_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m        matches%rowtype;
  v_mandate mandates%rowtype;
begin
  -- BEFORE-триггер срабатывает раньше проверки NOT NULL, поэтому отсутствие
  -- подбора надо назвать здесь — иначе наружу уйдёт «подбор <NULL> не найден».
  if new.match_id is null then
    raise exception 'INVARIANT_2: сделка без подбора невозможна'
      using errcode = 'not_null_violation';
  end if;

  select * into m from matches where id = new.match_id;
  if not found then
    raise exception 'INVARIANT_2: сделка ссылается на несуществующий подбор %', new.match_id
      using errcode = 'foreign_key_violation';
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

  -- Инвариант 3: стороны комиссии берутся из мандата и подбора, а не из запроса.
  if new.listing_agent_id <> v_mandate.listing_agent_id then
    raise exception 'INVARIANT_3: listing_agent сделки должен совпадать с listing_agent мандата (%)',
      v_mandate.listing_agent_id using errcode = 'check_violation';
  end if;

  if new.closing_agent_id <> m.closing_agent_id then
    raise exception 'INVARIANT_3: closing_agent сделки должен совпадать с closing_agent подбора (%)',
      m.closing_agent_id using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger b_deal_from_match
  before insert or update on deals
  for each row execute function app.check_deal_from_match();

-- Закрытие сделки: фиксация комиссии и закрытие мандата и потребности.
create or replace function app.on_deal_closed() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_total numeric;
  v_rule  jsonb;
  v_type  deal_type;
  s       record;
begin
  if new.status = 'closed' and coalesce(old.status, 'deposit') <> 'closed' then
    select o.deal_type, m.commission_rule into v_type, v_rule
      from objects o
      join mandates m on m.id = new.mandate_id
     where o.id = new.object_id;

    -- Инвариант 3: после закрытия считаем от ФИНАЛЬНОЙ цены и фиксируем.
    v_total := app.commission_total(v_type, new.final_price, v_rule);
    select * into s from app.commission_shares(v_total);

    update deals
       set commission_total = v_total,
           listing_share    = s.listing_share,
           closing_share    = s.closing_share,
           closed_at        = coalesce(new.closed_at, now())
     where id = new.id;

    -- Инвариант 2: закрытие сделки закрывает её мандат и её потребность.
    update mandates
       set status = 'closed_by_deal',
           closed_reason = 'закрыт сделкой ' || new.id::text
     where id = new.mandate_id
       and status <> 'closed_by_deal';

    update requirements
       set status = 'closed',
           closed_reason = 'закрыта сделкой ' || new.id::text
     where id = new.requirement_id
       and status <> 'closed';
  end if;
  return null;
end $$;

create trigger e_deal_closed
  after update of status on deals
  for each row execute function app.on_deal_closed();

-- ===========================================================================
-- ИНВАРИАНТ 5. actual_at обновляется, published_at не меняется никогда.
-- ===========================================================================

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
  -- Повторная публикация после снятия сохраняет ПЕРВУЮ дату.
  if new.publication_state = 'published' and old.publication_state <> 'published' then
    new.published_at := coalesce(old.published_at, now());
  else
    new.published_at := old.published_at;
  end if;

  -- actual_at: правка цены или фото поднимает актуальность.
  if new.price is distinct from old.price
     or new.photos is distinct from old.photos then
    new.actual_at := now();
  else
    -- Иначе значение разрешено менять только вперёд и не в будущее:
    -- это путь «подтвердить актуальность» (app.confirm_actual).
    if new.actual_at is distinct from old.actual_at then
      if new.actual_at < old.actual_at or new.actual_at > now() then
        new.actual_at := old.actual_at;
      end if;
    end if;
  end if;

  return new;
end $$;

create trigger a_object_timestamps
  before insert or update on objects
  for each row execute function app.object_timestamps();

-- Подтверждение актуальности — третий случай инварианта 5.
create or replace function app.confirm_actual(p_object_id uuid) returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v timestamptz;
begin
  perform app.require_agent();
  update objects set actual_at = now() where id = p_object_id
    returning actual_at into v;
  if v is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return v;
end $$;

-- ===========================================================================
-- Активность: полиморфная ссылка существует
-- ===========================================================================
-- FK на entity_id поставить нельзя, поэтому существование проверяет триггер.

create or replace function app.check_activity_target() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table text := case new.entity_type
    when 'contact'     then 'contacts'
    when 'object'      then 'objects'
    when 'mandate'     then 'mandates'
    when 'requirement' then 'requirements'
    when 'match'       then 'matches'
    when 'deal'        then 'deals'
  end;
  v_exists boolean;
begin
  execute format('select exists (select 1 from %I where id = $1)', v_table)
    into v_exists using new.entity_id;
  if not v_exists then
    raise exception 'активность ссылается на несуществующий % %', new.entity_type, new.entity_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

create trigger b_activity_target
  before insert or update of entity_type, entity_id on activities
  for each row execute function app.check_activity_target();
