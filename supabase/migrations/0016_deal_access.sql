-- 0016_deal_access.sql
--
-- Проверки прав в функциях слоя доступа.
--
-- ДЫРА. Функции из 0007 объявлены SECURITY DEFINER, то есть выполняются от
-- владельца таблиц и RLS НЕ ПРИМЕНЯЕТСЯ. Своей проверки прав у них не было,
-- поэтому на схеме до этой миграции посторонний агент мог:
--
--   1. close_deal(чужая сделка, любая цена) — закрыть чужую сделку и
--      зафиксировать комиссию. Проверено: закрыл сделку по цене 999000,
--      комиссия 19980 записана, мандат и потребность закрыты.
--   2. withdraw_object(чужой объект) — снять чужой объект с публикации.
--   3. create_match(объект, ЧУЖАЯ потребность) — назначить СЕБЯ
--      closing-агентом на чужого клиента. По инварианту 3 closing_agent
--      берётся из подбора, то есть это прямой захват половины комиссии.
--
-- Политики RLS от этого не защищали и защитить не могли: SECURITY DEFINER
-- их обходит by design. Значит проверка должна быть в самих функциях.

-- ---------------------------------------------------------------------------
-- Участник сделки
-- ---------------------------------------------------------------------------

create or replace function app.is_deal_party(p_deal_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or exists (
        select 1 from deals d
         where d.id = p_deal_id
           and app.current_agent_id() in (d.listing_agent_id, d.closing_agent_id))
$$;

grant execute on function app.is_deal_party(uuid) to authenticated;

create or replace function is_deal_party(p_deal_id uuid) returns boolean
  language sql security definer set search_path = public, pg_temp as $$
  select app.is_deal_party(p_deal_id)
$$;

grant execute on function is_deal_party(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Публикация, снятие, актуальность
-- ---------------------------------------------------------------------------
-- Те же права, что на правку объекта (0015): кто завёл, listing-агент
-- активного мандата, админ. Иначе выходило, что править объект посторонний
-- не может, а снять его с каталога — может.

create or replace function publish_object(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: публикует объект тот, кто его завёл, listing-агент активного мандата или админ'
      using errcode = '42501';
  end if;

  if app.active_mandate_id(p_object_id) is null then
    raise exception 'INVARIANT_1: объект нельзя опубликовать без активного мандата'
      using errcode = 'check_violation',
            hint = 'Заключите мандат с собственником, затем публикуйте.';
  end if;

  update objects set publication_state = 'published'
   where id = p_object_id returning * into r;

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

  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: снять объект с публикации может тот, кто его завёл, listing-агент активного мандата или админ'
      using errcode = '42501';
  end if;

  update objects set publication_state = 'withdrawn'
   where id = p_object_id returning * into r;

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

  -- Актуальность — утверждение о чужом объекте. Подтверждать её может только
  -- тот, кто за объект отвечает.
  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: подтвердить актуальность может тот, кто завёл объект, listing-агент активного мандата или админ'
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
-- Мандат: заключить может любой агент, если активного договора нет
-- ---------------------------------------------------------------------------
-- Здесь я сначала поставил проверку «только тот, кто завёл объект», и она
-- оказалась неверной. Обычная ситуация: объект в базу внёс один агент, а
-- договор с собственником есть у другого. При строгой проверке второй не
-- может его оформить, и объект остаётся непубликуемым до тех пор, пока не
-- вмешается первый агент или админ.
--
-- Заключение договора — это принесённая работа, а не действие над чужой.
-- Поэтому требуется только одно: активного мандата у объекта ещё нет
-- (инвариант 1). Публикация, снятие и подтверждение актуальности остаются
-- строгими: это действия над объектом, который уже кому-то принадлежит.
--
-- Остаточный риск признаю: агент может оформить договор на объект, который
-- внёс кто-то другой, и получить половину комиссии. Он виден — в журнале
-- записано, кто и когда завёл мандат, — и обратим: админ расторгает договор.
-- Запрет же ломает честный случай каждый раз.

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
  if not exists (select 1 from objects where id = p_object_id) then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  if app.active_mandate_id(p_object_id) is not null then
    raise exception 'INVARIANT_1: у объекта уже есть активный мандат'
      using errcode = 'check_violation',
            hint = 'Сначала расторгните действующий договор.';
  end if;

  -- listing-агентом становится тот, кто принёс договор.
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

-- ---------------------------------------------------------------------------
-- Подбор: closing-агент берётся из потребности, а не из того, кто нажал
-- ---------------------------------------------------------------------------
-- Прежде closing_agent_id ставился равным вызывающему, и это был захват
-- комиссии: по инварианту 3 доля closing-агента идёт тому, кто указан в
-- подборе. Теперь она идёт агенту, который ведёт клиента, кто бы подбор ни
-- создал. Предлагать объект чужому клиенту при этом по-прежнему можно —
-- это полезно и больше ничего не ломает.

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

  if v_obj.deal_type <> v_req.deal_type then
    raise exception 'подбор невозможен: объект это %, потребность это %',
      v_obj.deal_type, v_req.deal_type using errcode = 'check_violation';
  end if;

  if v_req.status in ('closed', 'lost') then
    raise exception 'потребность закрыта, подбор невозможен'
      using errcode = 'check_violation';
  end if;

  insert into matches (object_id, requirement_id, closing_agent_id, created_by_agent_id)
  values (p_object_id, p_requirement_id,
          -- Клиента ведёт агент потребности: его доля, не нажавшего кнопку.
          v_req.agent_id,
          v_agent)
  on conflict (object_id, requirement_id) do nothing
  returning * into r;

  if r.id is null then
    select * into r from matches
     where object_id = p_object_id and requirement_id = p_requirement_id;
  end if;
  return r;
end $$;

comment on function create_match is
  'Единственный путь создания подбора. closing_agent берётся из ПОТРЕБНОСТИ: иначе любой агент назначал бы себя closing-агентом на чужого клиента и забирал половину комиссии (инвариант 3).';

-- ---------------------------------------------------------------------------
-- Сделка: создаёт, закрывает и срывает только участник
-- ---------------------------------------------------------------------------

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

  -- Сделку начинает одна из её сторон. Третий агент не должен запускать
  -- чужую сделку: это закрывает мандат и переводит потребность.
  if not (app.is_admin() or v_agent in (v_listing, m.closing_agent_id)) then
    raise exception 'FORBIDDEN: сделку создаёт listing-агент мандата или агент, ведущий клиента'
      using errcode = '42501';
  end if;

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

create or replace function close_deal(p_deal_id uuid, p_final_price numeric)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  -- Закрытие фиксирует деньги: суммы комиссии и обе доли. Делать это может
  -- только сторона сделки.
  if not app.is_deal_party(p_deal_id) then
    raise exception 'FORBIDDEN: закрыть сделку может только её участник или админ'
      using errcode = '42501';
  end if;

  if p_final_price is null or p_final_price <= 0 then
    raise exception 'финальная цена обязательна для закрытия сделки'
      using errcode = 'check_violation';
  end if;

  update deals
     set status = 'closed', final_price = p_final_price, closed_at = now()
   where id = p_deal_id
  returning * into r;

  if r.id is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;

  select * into r from deals where id = p_deal_id;
  return r;
end $$;

create or replace function fail_deal(p_deal_id uuid, p_reason text)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if not app.is_deal_party(p_deal_id) then
    raise exception 'FORBIDDEN: сорвать сделку может только её участник или админ'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'причина срыва обязательна' using errcode = 'check_violation';
  end if;

  update deals set status = 'failed', failure_reason = p_reason
   where id = p_deal_id returning * into r;

  if r.id is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;

  update requirements set status = 'qualified'
   where id = r.requirement_id and status = 'in_deal';

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Движение сделки по этапам
-- ---------------------------------------------------------------------------
-- Аванс → документы → подписание → расчёт. Закрытие и срыв сюда не входят:
-- у них свои функции, потому что закрытие требует финальной цены и фиксирует
-- комиссию, а срыв — причину.

create or replace function set_deal_status(p_deal_id uuid, p_status deal_status)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if not app.is_deal_party(p_deal_id) then
    raise exception 'FORBIDDEN: менять этап сделки может только её участник или админ'
      using errcode = '42501';
  end if;

  if p_status = 'closed' then
    raise exception 'закрытие идёт через close_deal(): нужна финальная цена, от неё считается комиссия'
      using errcode = 'check_violation';
  end if;

  if p_status = 'failed' then
    raise exception 'срыв идёт через fail_deal(): нужна причина'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from deals where id = p_deal_id and status in ('closed', 'failed')) then
    raise exception 'сделка уже завершена, этап не меняется'
      using errcode = 'check_violation';
  end if;

  update deals set status = p_status where id = p_deal_id returning * into r;

  if r.id is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

grant execute on function set_deal_status(uuid, deal_status) to authenticated;

-- ---------------------------------------------------------------------------
-- Список сделок
-- ---------------------------------------------------------------------------

create or replace view deal_list_v
  with (security_invoker = true) as
select
  d.id,
  d.status,
  d.created_at,
  d.closed_at,
  d.final_price,
  d.failure_reason,
  d.match_id,
  d.object_id,
  d.requirement_id,
  d.mandate_id,

  o.address,
  o.deal_type,
  o.zone,
  o.rooms,
  o.price      as object_price,
  o.currency,

  d.listing_agent_id,
  la.full_name as listing_agent_name,
  d.closing_agent_id,
  ca.full_name as closing_agent_name,

  -- Суммы: до закрытия индикативные от текущей цены, после — зафиксированные.
  dc.commission_total,
  dc.listing_share,
  dc.closing_share,
  dc.is_indicative,

  -- Контакты: NULL, если инвариант 4 их этому агенту не отдаёт.
  (select c.name from requirements r
     join contacts c on c.id = r.contact_id
    where r.id = d.requirement_id)                                  as client_name,
  (select string_agg(c.name, ', ' order by c.name)
     from object_ownerships oo join contacts c on c.id = oo.contact_id
    where oo.object_id = d.object_id
      and oo.role in ('owner', 'co_owner'))                         as owners,

  app.is_deal_party(d.id) as can_act
from deals d
join objects o on o.id = d.object_id
left join agents la on la.id = d.listing_agent_id
left join agents ca on ca.id = d.closing_agent_id
left join deal_commission_v dc on dc.deal_id = d.id;

comment on view deal_list_v is
  'Список сделок. Контакты подзапросами — иначе join выбросил бы сделку у агента, которому контакт не положен.';

grant select on deal_list_v to authenticated;
revoke all   on deal_list_v from anon;
