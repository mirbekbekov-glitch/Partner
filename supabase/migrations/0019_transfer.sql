-- 0019_transfer.sql
-- Передача клиента и объекта коллеге.
--
-- Передача не сводится к правке одной колонки, и это проверено запросами:
--
-- 1. Если передвинуть requirements.agent_id, не двинув подборы, инвариант
--    из 0018 (closing_agent подбора = агент потребности) оказывается
--    нарушенным на СУЩЕСТВУЮЩИХ строках — триггер на matches при правке
--    requirements не срабатывает. Подбор остаётся правимым, и расхождение
--    живёт молча. Значит передача обязана двигать и подборы.
--
-- 2. Если при этом по подбору идёт ОТКРЫТАЯ сделка, приведение подбора в
--    соответствие делает сделку незакрываемой: check_deal_from_match()
--    требует, чтобы closing_agent сделки совпадал с closing_agent подбора,
--    а в сделке он заморожен. Проверено: close_deal() падает с INVARIANT_3.
--    Значит передача при открытых сделках должна отказывать, а не ломать их.
--
-- Отсюда правило: передаётся всё, что составляет работу с клиентом или
-- объектом, одной транзакцией, и только когда открытых сделок нет.
-- Комиссия по уже идущей сделке остаётся у тех, кто её ведёт.

create or replace function app.assert_transfer_target(p_to_agent_id uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_to_agent_id is null then
    raise exception 'укажите, кому передаёте' using errcode = 'check_violation';
  end if;

  if p_to_agent_id = app.current_agent_id() then
    raise exception 'это вы и есть: передавать себе нечего'
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from agents
                  where id = p_to_agent_id and status = 'approved') then
    raise exception 'принимающий агент не найден или не одобрен'
      using errcode = 'check_violation',
            hint = 'Передать работу можно только одобренному агенту.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Передача клиента
-- ---------------------------------------------------------------------------
-- Переезжает: сам контакт, его ОТКРЫТЫЕ потребности и подборы по ним.
--
-- Закрытые потребности и отвал остаются за тем, кто их вёл: это уже
-- сделанная работа, и переписывать её авторство незачем. Подборы по ним
-- тоже остаются, поэтому инвариант 0018 на них не нарушается.

create or replace function transfer_contact(
  p_contact_id   uuid,
  p_to_agent_id  uuid
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me       uuid := app.require_agent();
  v_contact  contacts%rowtype;
  v_open     text;
  v_reqs     int;
  v_matches  int;
begin
  select * into v_contact from contacts where id = p_contact_id;
  if not found then
    raise exception 'контакт % не найден', p_contact_id using errcode = 'no_data_found';
  end if;

  if not (v_contact.owner_agent_id = v_me or app.is_admin()) then
    raise exception 'FORBIDDEN: передать клиента может тот, кто его ведёт, или админ'
      using errcode = '42501';
  end if;

  perform app.assert_transfer_target(p_to_agent_id);

  -- Открытые сделки: передача их сломала бы, поэтому называем их и отказываем.
  select string_agg(o.address, ', ') into v_open
    from deals d
    join requirements r on r.id = d.requirement_id
    join objects o on o.id = d.object_id
   where r.contact_id = p_contact_id
     and d.status not in ('closed', 'failed');

  if v_open is not null then
    raise exception
      'по клиенту идут незавершённые сделки (%) — сначала закройте их или отметьте срыв', v_open
      using errcode = 'check_violation',
            hint = 'Комиссия по идущей сделке принадлежит тем, кто её ведёт, поэтому передача их не переписывает.';
  end if;

  update contacts set owner_agent_id = p_to_agent_id where id = p_contact_id;

  -- Порядок важен: сперва потребности, потом подборы. Триггер на matches
  -- сверяет closing_agent с УЖЕ новым агентом потребности.
  with moved as (
    update requirements set agent_id = p_to_agent_id
     where contact_id = p_contact_id
       and status not in ('closed', 'lost')
    returning id
  ) select count(*) into v_reqs from moved;

  with moved as (
    update matches m set closing_agent_id = p_to_agent_id
     where exists (select 1 from requirements r
                    where r.id = m.requirement_id
                      and r.contact_id = p_contact_id
                      and r.agent_id = p_to_agent_id)
    returning m.id
  ) select count(*) into v_matches from moved;

  return jsonb_build_object(
    'contact_id',   p_contact_id,
    'contact_name', v_contact.name,
    'to_agent_id',  p_to_agent_id,
    'requirements', v_reqs,
    'matches',      v_matches
  );
end $$;

comment on function transfer_contact is
  'Передача клиента: контакт, его открытые потребности и подборы по ним. Отказывает при незавершённых сделках — их комиссия принадлежит тем, кто их ведёт.';

-- ---------------------------------------------------------------------------
-- Передача объекта
-- ---------------------------------------------------------------------------
-- Переезжает: сам объект (created_by, от него зависит право правки) и
-- listing-агент активного мандата — а с ним и доля listing в комиссии.

create or replace function transfer_object(
  p_object_id   uuid,
  p_to_agent_id uuid
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_obj     objects%rowtype;
  v_open    text;
  v_mandate uuid;
begin
  select * into v_obj from objects where id = p_object_id;
  if not found then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  perform app.require_agent();

  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: передать объект может тот, кто его завёл, listing-агент активного мандата или админ'
      using errcode = '42501';
  end if;

  perform app.assert_transfer_target(p_to_agent_id);

  select string_agg(coalesce(c.name, 'клиент скрыт'), ', ') into v_open
    from deals d
    left join requirements r on r.id = d.requirement_id
    left join contacts c on c.id = r.contact_id
   where d.object_id = p_object_id
     and d.status not in ('closed', 'failed');

  if v_open is not null then
    raise exception
      'по объекту идут незавершённые сделки (%) — сначала закройте их или отметьте срыв', v_open
      using errcode = 'check_violation',
            hint = 'Комиссия по идущей сделке принадлежит тем, кто её ведёт, поэтому передача их не переписывает.';
  end if;

  update objects set created_by_agent_id = p_to_agent_id where id = p_object_id;

  -- Доля listing-агента идёт из мандата (инвариант 3), поэтому вместе с
  -- объектом переезжает и она.
  v_mandate := app.active_mandate_id(p_object_id);
  if v_mandate is not null then
    update mandates set listing_agent_id = p_to_agent_id where id = v_mandate;
  end if;

  return jsonb_build_object(
    'object_id',   p_object_id,
    'address',     v_obj.address,
    'to_agent_id', p_to_agent_id,
    'mandate_moved', v_mandate is not null
  );
end $$;

comment on function transfer_object is
  'Передача объекта: created_by и listing-агент активного мандата, то есть вместе с долей listing в комиссии.';

grant execute on function
  transfer_contact(uuid, uuid), transfer_object(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Кому можно передать
-- ---------------------------------------------------------------------------
-- Форме нужен список одобренных коллег. Отдельное представление, потому что
-- agents агенту виден целиком, а здесь нужны только те, кому передача
-- вообще возможна, и без лишних полей.

create or replace view transfer_targets_v
  with (security_invoker = true) as
select a.id, a.full_name, a.role
  from agents a
 where a.status = 'approved'
   and a.id <> app.current_agent_id();

grant select on transfer_targets_v to authenticated;
revoke all   on transfer_targets_v from anon;
