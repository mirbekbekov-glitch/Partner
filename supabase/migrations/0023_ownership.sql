-- 0023_ownership.sql
-- Собственность объекта: правка с карточки контакта.
--
-- Что проверено на схеме до этой миграции:
--
--   1. Сумма долей по объекту доходила до 2.6 — ничто не держало сто
--      процентов. Доля это не пометка, а основание для раздела денег.
--   2. Существующую связь можно было переподвязать на другой объект
--      прямым UPDATE: структурное поле было открыто.
--   3. Снятие связи объекта с собственником при ОТКРЫТОЙ сделке отбирало у
--      closing-агента доступ к телефону собственника, а сделка шла дальше.
--      Проверено: видел 1 телефон, после снятия 0, сделка в статусе deposit.
--      Причина в том, что can_see_contact() для участников сделки опирается
--      именно на object_ownerships — связь и есть основание доступа.

-- ---------------------------------------------------------------------------
-- Доли не превышают целого
-- ---------------------------------------------------------------------------
-- Межстрочное правило, поэтому триггер, а не CHECK: CHECK видит только свою
-- строку. NULL означает «доля не определена» и в сумму не идёт.

create or replace function app.check_ownership_shares() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_object uuid := coalesce(new.object_id, old.object_id);
  v_sum    numeric;
begin
  select coalesce(sum(share), 0) into v_sum
    from object_ownerships
   where object_id = v_object and share is not null;

  if v_sum > 1 then
    raise exception
      'сумма долей по объекту вышла бы за единицу: % — доля это основание для раздела комиссии, а не пометка',
      v_sum
      using errcode = 'check_violation',
            hint = 'Уменьшите доли других собственников или оставьте долю пустой, если она неизвестна.';
  end if;
  return null;
end $$;

create constraint trigger c_ownership_shares
  after insert or update of share, object_id on object_ownerships
  deferrable initially immediate
  for each row execute function app.check_ownership_shares();

-- ---------------------------------------------------------------------------
-- Пока идёт сделка, объект не остаётся без собственника
-- ---------------------------------------------------------------------------
-- Снятие последнего собственника во время сделки отбирает у участников
-- доступ к его телефону и оставляет сделку без стороны, с которой она
-- заключена. Добавлять собственников при этом можно свободно: это только
-- расширяет доступ. Поэтому правило узкое — «не оставить без собственника», —
-- и исправить ошибочно указанного собственника по-прежнему можно: сначала
-- добавить верного, потом снять неверного.

create or replace function app.check_ownership_kept() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_object uuid := coalesce(old.object_id, new.object_id);
begin
  if exists (select 1 from deals d
              where d.object_id = v_object
                and d.status not in ('closed', 'failed'))
     and not exists (select 1 from object_ownerships oo
                      where oo.object_id = v_object
                        and oo.role in ('owner', 'co_owner')) then
    raise exception
      'по объекту идёт сделка — он не может остаться без собственника'
      using errcode = 'check_violation',
            hint = 'Сначала добавьте верного собственника, затем снимайте неверного. Связь с собственником — основание доступа участников сделки к его телефону.';
  end if;
  return null;
end $$;

create constraint trigger c_ownership_kept_during_deal
  after delete or update of role, contact_id on object_ownerships
  deferrable initially immediate
  for each row execute function app.check_ownership_kept();

-- ---------------------------------------------------------------------------
-- Структурные поля связи не переписываются
-- ---------------------------------------------------------------------------
-- Связь — это пара «объект + контакт». Переподвязать её к другому объекту
-- значит не исправить, а подменить: правильный путь — снять и завести
-- заново, и тогда оба действия видны в журнале по отдельности.

revoke update on object_ownerships from authenticated;
grant update (role, share) on object_ownerships to authenticated;

-- ---------------------------------------------------------------------------
-- Связать, изменить, снять
-- ---------------------------------------------------------------------------
-- Ключ связи — (object_id, contact_id, role), поэтому смена роли это не
-- UPDATE одной строки, а перенос: иначе агент получает «ещё одну» связь
-- вместо изменённой. Функция это скрывает.

create or replace function set_object_ownership(
  p_object_id  uuid,
  p_contact_id uuid,
  p_role       ownership_role,
  p_share      numeric default null
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_agent();

  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: связать контакт с объектом может тот, кто за объект отвечает'
      using errcode = '42501';
  end if;

  if not app.can_see_contact(p_contact_id) then
    raise exception 'FORBIDDEN: этот контакт вам не доступен'
      using errcode = '42501';
  end if;

  if p_share is not null and (p_share <= 0 or p_share > 1) then
    raise exception 'доля задаётся числом от 0 до 1 — например 0.5 для половины'
      using errcode = 'check_violation';
  end if;

  -- Роль входит в ключ, поэтому прежние роли этого контакта по этому
  -- объекту убираем: у человека по одному объекту одна роль, а не набор.
  delete from object_ownerships
   where object_id = p_object_id and contact_id = p_contact_id and role <> p_role;

  insert into object_ownerships (object_id, contact_id, role, share)
  values (p_object_id, p_contact_id, p_role, p_share)
  on conflict (object_id, contact_id, role)
    do update set share = excluded.share;

  return jsonb_build_object('object_id', p_object_id, 'contact_id', p_contact_id,
                            'role', p_role, 'share', p_share);
end $$;

create or replace function remove_object_ownership(
  p_object_id  uuid,
  p_contact_id uuid
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int;
begin
  perform app.require_agent();

  if not app.can_edit_object(p_object_id) then
    raise exception 'FORBIDDEN: снять связь может тот, кто отвечает за объект'
      using errcode = '42501';
  end if;

  with gone as (
    delete from object_ownerships
     where object_id = p_object_id and contact_id = p_contact_id
    returning 1
  ) select count(*) into v_count from gone;

  if v_count = 0 then
    raise exception 'связь не найдена' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object('removed', v_count);
end $$;

grant execute on function
  set_object_ownership(uuid, uuid, ownership_role, numeric),
  remove_object_ownership(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Объекты, с которыми можно связать контакт
-- ---------------------------------------------------------------------------
-- Только те, за которые агент отвечает: предлагать чужие бессмысленно,
-- связь всё равно не пройдёт.

create or replace view linkable_objects_v
  with (security_invoker = true) as
select o.id, o.address, o.deal_type, o.price, o.currency, o.publication_state
  from objects o
 where app.can_edit_object(o.id);

grant select on linkable_objects_v to authenticated;
revoke all   on linkable_objects_v from anon;
