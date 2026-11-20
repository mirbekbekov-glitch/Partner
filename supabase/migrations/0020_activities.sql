-- 0020_activities.sql
-- Активности: звонки, показы, задачи, заметки, сообщения.
--
-- Что проверено на схеме до этой миграции:
--   1. done = true принимался без done_at: «выполнено», но неизвестно когда.
--   2. done_at принимался в будущем и при done = false — бессмыслица.
--   3. listing-агент видел НОЛЬ активностей коллеги по своему объекту.
--      Это моё решение из 0006 (автор и админ), и оно было строже задания:
--      свободный текст легко содержит телефон, а инвариант 4 его закрывает.
--      Для работы это оказалось слишком строго — показ записан, а
--      согласовать его с listing-агентом нечем.

-- ---------------------------------------------------------------------------
-- done и done_at не расходятся
-- ---------------------------------------------------------------------------

create or replace function app.activity_done_at() returns trigger
  language plpgsql as $$
begin
  if new.done then
    -- Отметили выполненной — фиксируем когда, если не сказано иное.
    new.done_at := coalesce(
      case when tg_op = 'UPDATE' and old.done then old.done_at else null end,
      new.done_at,
      now());
    -- В будущем «уже выполнено» быть не может.
    if new.done_at > now() then
      new.done_at := now();
    end if;
  else
    -- Сняли отметку — дата выполнения теряет смысл.
    new.done_at := null;
  end if;
  return new;
end $$;

create trigger a_activity_done_at
  before insert or update on activities
  for each row execute function app.activity_done_at();

-- Чтобы клиенту не приходилось знать свой agent_id.
alter table activities alter column agent_id set default app.current_agent_id();

-- ---------------------------------------------------------------------------
-- Можно поделиться с теми, кто работает с этой сущностью
-- ---------------------------------------------------------------------------
-- По умолчанию активность приватна: текст пишет человек, и телефон в нём
-- оказывается незаметно. Поделиться — отдельное осознанное действие автора,
-- и аудитория узкая: не «все агенты», а те, кто может действовать по этой
-- сущности.
--
-- ОСТАТОЧНЫЙ РИСК. Если автор напишет в заметку телефон клиента и поделится
-- ею на объекте, его увидит listing-агент объекта — а инвариант 4 телефон
-- клиента ему не даёт, пока нет активной сделки. Защита здесь человеческая:
-- приватно по умолчанию, узкая аудитория и прямое предупреждение в форме.
-- Полностью убрать риск можно только запретив делиться, и тогда согласовать
-- показ в системе будет нечем.

alter table activities add column is_shared boolean not null default false;

comment on column activities.is_shared is
  'Автор поделился активностью с теми, кто работает по этой сущности. По умолчанию ложь: текст может содержать телефон (инвариант 4).';

create or replace function app.can_see_entity_activity(
  p_entity_type text,
  p_entity_id   uuid
) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return case p_entity_type
    when 'object'      then app.can_edit_object(p_entity_id)
    when 'match'       then app.can_lead_match(p_entity_id)
    when 'deal'        then app.is_deal_party(p_entity_id)
    when 'contact'     then app.can_see_contact(p_entity_id)
    when 'requirement' then exists (select 1 from requirements r
                                     where r.id = p_entity_id
                                       and (r.agent_id = app.current_agent_id()
                                            or app.is_admin()))
    when 'mandate'     then exists (select 1 from mandates m
                                     where m.id = p_entity_id
                                       and (m.listing_agent_id = app.current_agent_id()
                                            or app.is_admin()))
    else false
  end;
end $$;

grant execute on function app.can_see_entity_activity(text, uuid) to authenticated;

drop policy activities_read on activities;

create policy activities_read on activities for select
  using (
    agent_id = app.current_agent_id()
    or app.is_admin()
    or (is_shared and app.can_see_entity_activity(entity_type, entity_id))
  );

comment on policy activities_read on activities is
  'Своё видно всегда. Чужое — только если автор поделился И агент может действовать по этой сущности.';

-- Делиться можно только своей активностью: политики на правку это уже
-- обеспечивают (agent_id = свой), менять их не нужно.

-- ---------------------------------------------------------------------------
-- Поля, которых клиент не касается
-- ---------------------------------------------------------------------------
-- agent_id — иначе активность дарят или присваивают (присвоение политика
-- отбивала, дарение нет). done_at ведёт триггер выше.

revoke update on activities from authenticated;
grant update (kind, entity_type, entity_id, body, due_at, done, is_shared)
  on activities to authenticated;

revoke insert on activities from authenticated;
grant insert (kind, entity_type, entity_id, agent_id, body, due_at, done, is_shared)
  on activities to authenticated;

-- ---------------------------------------------------------------------------
-- Лента активностей
-- ---------------------------------------------------------------------------

create or replace view activity_feed_v
  with (security_invoker = true) as
select
  a.id,
  a.kind,
  a.entity_type,
  a.entity_id,
  a.body,
  a.due_at,
  a.done,
  a.done_at,
  a.is_shared,
  a.created_at,
  a.agent_id,
  ag.full_name as agent_name,
  (a.agent_id = app.current_agent_id()) as mine,
  -- Просрочено: срок прошёл, а не выполнено.
  (not a.done and a.due_at is not null and a.due_at < now()) as overdue,
  -- Чтобы лента могла показать, к чему привязана активность, без второго
  -- запроса на каждую строку.
  case a.entity_type
    when 'object'      then (select o.address from objects o where o.id = a.entity_id)
    when 'requirement' then (select coalesce(c.name, 'клиент скрыт')
                               from requirements r
                               left join contacts c on c.id = r.contact_id
                              where r.id = a.entity_id)
    when 'contact'     then (select c.name from contacts c where c.id = a.entity_id)
    when 'deal'        then (select o.address from deals d
                               join objects o on o.id = d.object_id
                              where d.id = a.entity_id)
    when 'match'       then (select o.address from matches m
                               join objects o on o.id = m.object_id
                              where m.id = a.entity_id)
    when 'mandate'     then (select o.address from mandates md
                               join objects o on o.id = md.object_id
                              where md.id = a.entity_id)
  end as entity_title
from activities a
left join agents ag on ag.id = a.agent_id;

comment on view activity_feed_v is
  'Лента активностей. entity_title подзапросами: заголовок чужой сущности придёт пустым, если RLS её не отдаёт, и строка активности при этом не исчезнет.';

grant select on activity_feed_v to authenticated;
revoke all   on activity_feed_v from anon;

-- Просроченные задачи ищутся часто — отдельный индекс под этот запрос.
create index activities_overdue_idx on activities (agent_id, due_at)
  where not done and due_at is not null;

-- ---------------------------------------------------------------------------
-- Понятное сообщение при неизвестном типе сущности
-- ---------------------------------------------------------------------------
-- BEFORE-триггер срабатывает РАНЬШЕ проверки CHECK, поэтому при неизвестном
-- entity_type прежняя версия падала не на ограничении, а внутри format():
-- «null values cannot be formatted as an SQL identifier». Ограничение бы
-- поймало, но наружу уходило сообщение, по которому ничего не понять.

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
  if v_table is null then
    raise exception 'неизвестный тип сущности «%» для активности', new.entity_type
      using errcode = 'check_violation',
            hint = 'Допустимы: contact, object, mandate, requirement, match, deal.';
  end if;

  execute format('select exists (select 1 from %I where id = $1)', v_table)
    into v_exists using new.entity_id;

  if not v_exists then
    raise exception 'активность ссылается на несуществующий % %', new.entity_type, new.entity_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
