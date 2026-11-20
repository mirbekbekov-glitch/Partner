-- 0022_merge_contacts.sql
-- Объединение двух записей одного человека.
--
-- С 0021 новые дубликаты схема не пускает, но уже существующие — например
-- заведённые с разными номерами — склеить было нечем.
--
-- ПОРЯДОК ШАГОВ ЗДЕСЬ КРИТИЧЕН, и это не стиль, а проверенный факт.
-- Ссылки на contacts устроены так:
--
--   requirements.contact_id    ON DELETE CASCADE   ← удаление УНИЧТОЖИТ потребности
--   contact_phones.contact_id  ON DELETE CASCADE   ← и телефоны
--   object_ownerships.contact_id ON DELETE RESTRICT ← удалить не даст вовсе
--
-- Поэтому лишняя запись удаляется ПОСЛЕДНЕЙ, когда с неё уже всё снято.
-- Удалить сначала — значит потерять потребности клиента молча.
--
-- Мешают ещё два уникальных индекса:
--   contact_phones_one_primary_idx — один основной номер на контакт;
--   object_ownerships_pkey (object_id, contact_id, role) — если обе записи
--   указаны собственниками одного объекта в одной роли.
-- Оба случая обрабатываются, а не обходятся.

create or replace function merge_contacts(
  p_keep_id  uuid,
  p_merge_id uuid
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me         uuid := app.require_agent();
  v_keep       contacts%rowtype;
  v_merge      contacts%rowtype;
  v_phones     int;
  v_owns       int;
  v_owns_drop  int;
  v_reqs       int;
  v_acts       int;
begin
  if p_keep_id = p_merge_id then
    raise exception 'это одна и та же запись' using errcode = 'check_violation';
  end if;

  select * into v_keep  from contacts where id = p_keep_id;
  if not found then
    raise exception 'контакт % не найден', p_keep_id using errcode = 'no_data_found';
  end if;

  select * into v_merge from contacts where id = p_merge_id;
  if not found then
    raise exception 'контакт % не найден', p_merge_id using errcode = 'no_data_found';
  end if;

  -- Объединять можно только СВОИ записи. Иначе объединение становится
  -- способом забрать чужого клиента: приписал его к своей записи — и он
  -- твой, вместе с телефоном и потребностями. Дубликат на двух агентов
  -- сначала передаётся одному (transfer_contact) либо склеивается админом.
  if not (app.is_admin()
          or (v_keep.owner_agent_id = v_me and v_merge.owner_agent_id = v_me)) then
    raise exception
      'FORBIDDEN: объединять можно свои записи — обе. Если дубликат у коллеги, сначала передайте запись друг другу или попросите админа'
      using errcode = '42501';
  end if;

  -- ---- 1. Телефоны -------------------------------------------------------
  -- Основной номер может быть только один на контакт, поэтому у
  -- присоединяемой записи отметку снимаем. Столкновения по самому номеру
  -- быть не может: с 0021 номер уникален глобально, значит одинаковых
  -- номеров у двух контактов не существует.
  update contact_phones set is_primary = false
   where contact_id = p_merge_id and is_primary;

  with moved as (
    update contact_phones set contact_id = p_keep_id
     where contact_id = p_merge_id
    returning 1
  ) select count(*) into v_phones from moved;

  -- Если у остающейся записи основного номера нет, делаем им первый.
  if not exists (select 1 from contact_phones
                  where contact_id = p_keep_id and is_primary) then
    update contact_phones set is_primary = true
     where id = (select id from contact_phones
                  where contact_id = p_keep_id order by created_at limit 1);
  end if;

  -- ---- 2. Собственность --------------------------------------------------
  -- Ключ (object_id, contact_id, role): если обе записи указаны в одной роли
  -- по одному объекту, перенос упёрся бы в него. Лишнюю связь удаляем —
  -- она дублирует уже существующую у остающейся записи.
  with dropped as (
    delete from object_ownerships oo
     where oo.contact_id = p_merge_id
       and exists (select 1 from object_ownerships k
                    where k.object_id = oo.object_id
                      and k.contact_id = p_keep_id
                      and k.role = oo.role)
    returning 1
  ) select count(*) into v_owns_drop from dropped;

  with moved as (
    update object_ownerships set contact_id = p_keep_id
     where contact_id = p_merge_id
    returning 1
  ) select count(*) into v_owns from moved;

  -- ---- 3. Потребности ----------------------------------------------------
  -- Ведущий агент потребности НЕ меняется: кто её вёл, тот и ведёт. Поэтому
  -- инвариант 0018 (closing_agent подбора = агент потребности) не затронут,
  -- и подборы двигать не нужно.
  with moved as (
    update requirements set contact_id = p_keep_id
     where contact_id = p_merge_id
    returning 1
  ) select count(*) into v_reqs from moved;

  -- ---- 4. Активности -----------------------------------------------------
  with moved as (
    update activities set entity_id = p_keep_id
     where entity_type = 'contact' and entity_id = p_merge_id
    returning 1
  ) select count(*) into v_acts from moved;

  -- ---- 5. Поля самой записи ---------------------------------------------
  -- Роли объединяются: в этом и смысл правила «роли это флаги одной
  -- записи». Пустые поля остающейся записи заполняются из присоединяемой,
  -- заметки склеиваются — терять написанное человеком незачем.
  update contacts set
    roles = (select array_agg(distinct r)
               from unnest(v_keep.roles || v_merge.roles) r),
    telegram = coalesce(v_keep.telegram, v_merge.telegram),
    source   = coalesce(v_keep.source,   v_merge.source),
    note     = case
                 when v_keep.note is null then v_merge.note
                 when v_merge.note is null then v_keep.note
                 else v_keep.note || E'\n— из объединённой записи «' ||
                      v_merge.name || E'»:\n' || v_merge.note
               end
  where id = p_keep_id;

  -- ---- 6. И только теперь удаляем -------------------------------------
  -- Всё снято, CASCADE уже нечего уносить, RESTRICT не мешает.
  delete from contacts where id = p_merge_id;

  return jsonb_build_object(
    'kept_id',        p_keep_id,
    'kept_name',      v_keep.name,
    'merged_name',    v_merge.name,
    'phones',         v_phones,
    'ownerships',     v_owns,
    'ownerships_dropped', v_owns_drop,
    'requirements',   v_reqs,
    'activities',     v_acts
  );
end $$;

comment on function merge_contacts is
  'Склейка двух записей одного человека. Лишняя удаляется ПОСЛЕДНЕЙ: requirements и contact_phones ссылаются на контакт с ON DELETE CASCADE, и удаление раньше переноса уничтожило бы потребности клиента.';

grant execute on function merge_contacts(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Кандидаты в дубликаты
-- ---------------------------------------------------------------------------
-- Чтобы объединение не требовало вручную искать, что с чем склеивать.
-- Сравниваем по имени, приведённому к сопоставимому виду: номера у таких
-- записей заведомо разные, иначе 0021 их бы и не создала.

create or replace function app.normalize_name(p_name text) returns text
  language sql immutable as $$
  select regexp_replace(lower(btrim(coalesce(p_name, ''))), '\s+', ' ', 'g')
$$;

create or replace view contact_duplicates_v
  with (security_invoker = true) as
select
  a.id            as id,
  a.name          as name,
  b.id            as other_id,
  b.name          as other_name,
  a.created_at    as created_at,
  b.created_at    as other_created_at,
  (select count(*) from contact_phones cp where cp.contact_id = a.id)   as phones,
  (select count(*) from contact_phones cp where cp.contact_id = b.id)   as other_phones,
  (select count(*) from requirements r where r.contact_id = a.id)       as requirements,
  (select count(*) from requirements r where r.contact_id = b.id)       as other_requirements
from contacts a
join contacts b
  on app.normalize_name(a.name) = app.normalize_name(b.name)
 and a.id < b.id;

comment on view contact_duplicates_v is
  'Подозрения на дубликат по совпадению имени. Представление security_invoker, поэтому пара видна только если инвариант 4 отдаёт ОБЕ записи.';

grant select on contact_duplicates_v to authenticated;
revoke all   on contact_duplicates_v from anon;
