-- 0017_match_status.sql
-- Ведение подбора по статусам из кабинета.
--
-- ДЫРА, которую здесь затыкаем: статус 'in_deal' можно было поставить
-- прямым запросом при нуле сделок. Политика matches_update разрешает правку
-- closing-агенту, PostgREST отдаёт таблицу напрямую, и подбор начинал врать —
-- заявлял сделку, которой нет, и в списке сделок её, конечно, не было.
-- Проверено на схеме до этой миграции: статус in_deal при 0 сделок.

-- ---------------------------------------------------------------------------
-- 'in_deal' означает, что сделка действительно есть
-- ---------------------------------------------------------------------------
-- Триггер, а не только проверка в функции: прямой PATCH /matches функцию не
-- трогает. create_deal_from_match() сначала вставляет сделку и только потом
-- переводит подбор, поэтому для законного пути условие уже выполнено.

create or replace function app.check_match_in_deal() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'in_deal'
     and not exists (select 1 from deals d
                      where d.match_id = new.id and d.status <> 'failed') then
    raise exception
      'INVARIANT_2: статус «в сделке» означает существующую сделку — создайте её из подбора'
      using errcode = 'check_violation';
  end if;

  -- Обратное тоже: пока сделка жива, подбор не уводят в другой статус.
  -- Иначе сделка осталась бы висеть на подборе, который её отрицает.
  if tg_op = 'UPDATE'
     and old.status = 'in_deal' and new.status <> 'in_deal'
     and exists (select 1 from deals d
                  where d.match_id = new.id and d.status not in ('failed', 'closed')) then
    raise exception
      'INVARIANT_2: по подбору идёт сделка — сначала закройте её или отметьте срыв'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create constraint trigger c_match_in_deal_requires_deal
  after insert or update of status on matches
  deferrable initially immediate
  for each row execute function app.check_match_in_deal();

-- ---------------------------------------------------------------------------
-- Кто ведёт подбор
-- ---------------------------------------------------------------------------
-- Те же, кому даёт права политика matches_update: агент, ведущий клиента, и
-- автор подбора. Статусы подбора — это реакция клиента («интересно»,
-- «отказ», причина отказа), поэтому распоряжается ими клиентская сторона.

create or replace function app.can_lead_match(p_match_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or exists (select 1 from matches m
                  where m.id = p_match_id
                    and app.current_agent_id() in (m.closing_agent_id, m.created_by_agent_id))
$$;

create or replace function can_lead_match(p_match_id uuid) returns boolean
  language sql security definer set search_path = public, pg_temp as $$
  select app.can_lead_match(p_match_id)
$$;

grant execute on function app.can_lead_match(uuid), can_lead_match(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Смена статуса подбора
-- ---------------------------------------------------------------------------

create or replace function set_match_status(
  p_match_id   uuid,
  p_status     match_status,
  p_reason     text        default null,
  p_showing_at timestamptz default null
) returns matches
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old matches%rowtype;
  v_showing timestamptz;
  r     matches;
begin
  perform app.require_agent();

  select * into v_old from matches where id = p_match_id;
  if not found then
    raise exception 'подбор % не найден', p_match_id using errcode = 'no_data_found';
  end if;

  if not app.can_lead_match(p_match_id) then
    raise exception 'FORBIDDEN: вести подбор может агент, ведущий клиента, автор подбора или админ'
      using errcode = '42501';
  end if;

  -- Инвариант 2: «в сделке» ставится созданием сделки, а не руками.
  if p_status = 'in_deal' and v_old.status <> 'in_deal' then
    raise exception 'INVARIANT_2: статус «в сделке» ставится созданием сделки из подбора, а не вручную'
      using errcode = 'check_violation';
  end if;

  -- Отказ без причины бессмыслен: аналитика отвала строится на ней.
  if p_status = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'укажите причину отказа'
      using errcode = 'check_violation';
  end if;

  v_showing := coalesce(p_showing_at, v_old.showing_at);

  -- Назначенный показ без даты — не назначенный показ.
  if p_status = 'showing_scheduled' and v_showing is null then
    raise exception 'укажите дату и время показа'
      using errcode = 'check_violation';
  end if;

  if p_status = 'showing_done' and v_showing is null then
    raise exception 'укажите, когда показ состоялся'
      using errcode = 'check_violation';
  end if;

  update matches set
    status           = p_status,
    -- Уходя из отказа, причину убираем: она относилась к прошлому решению.
    rejection_reason = case when p_status = 'rejected'
                            then btrim(p_reason) else null end,
    showing_at       = v_showing
  where id = p_match_id
  returning * into r;

  return r;
end $$;

comment on function set_match_status is
  'Ведение подбора. «В сделке» не принимает: это следствие создания сделки (инвариант 2). Отказ требует причины, показ — даты.';

grant execute on function set_match_status(uuid, match_status, text, timestamptz)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Право вести подбор — в представления кабинета
-- ---------------------------------------------------------------------------
-- Чтобы страница не выводила право сама: кнопки показываются только тому,
-- кто действительно может ими воспользоваться.

create or replace view object_matches_v
  with (security_invoker = true) as
select
  mt.id                as match_id,
  mt.object_id,
  mt.requirement_id,
  mt.status            as match_status,
  mt.showing_at,
  mt.rejection_reason,
  mt.created_at,
  mt.closing_agent_id,
  ca.full_name         as closing_agent_name,
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms              as rooms_wanted,
  r.deadline,
  r.status             as requirement_status,
  r.contact_id,
  c.name               as client_name,
  mc.commission_total,
  mc.listing_share,
  mc.closing_share,
  d.id                 as deal_id,
  d.status             as deal_status,
  app.can_lead_match(mt.id) as can_lead
from matches mt
join      requirements r  on r.id  = mt.requirement_id
left join contacts     c  on c.id  = r.contact_id
left join agents       ca on ca.id = mt.closing_agent_id
left join match_commission_v mc on mc.match_id = mt.id
left join deals        d  on d.match_id = mt.id and d.status <> 'failed';

create or replace view requirement_matches_v
  with (security_invoker = true) as
select
  mt.id                as match_id,
  mt.requirement_id,
  mt.object_id,
  mt.status            as match_status,
  mt.showing_at,
  mt.rejection_reason,
  mt.created_at,
  o.kind,
  o.deal_type,
  o.address,
  o.zone,
  o.rooms,
  o.area,
  o.floor,
  o.price,
  o.currency,
  o.publication_state,
  o.actual_at,
  m.id                 as mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.listing_agent_id,
  la.full_name         as listing_agent_name,
  oo.contact_id        as owner_contact_id,
  oc.name              as owner_name,
  mc.commission_total,
  mc.listing_share,
  mc.closing_share,
  d.id                 as deal_id,
  d.status             as deal_status,
  app.can_lead_match(mt.id) as can_lead
from matches mt
join      objects  o  on o.id = mt.object_id
left join mandates m  on m.object_id = mt.object_id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join object_ownerships oo on oo.object_id = mt.object_id and oo.role = 'owner'
left join contacts oc on oc.id = oo.contact_id
left join match_commission_v mc on mc.match_id = mt.id
left join deals    d  on d.match_id = mt.id and d.status <> 'failed';

grant select on object_matches_v, requirement_matches_v to authenticated;
revoke all   on object_matches_v, requirement_matches_v from anon;
