-- 0021_contacts.sql
-- Контакты: раздел в кабинете и правило «один человек — одна запись».
--
-- Задание говорит прямо: «Один человек — одна запись, роли это флаги».
-- Схема этого не держала, и проверка это показала:
--   • два контакта с телефоном +996700111222 уживались свободно;
--   • тот же номер в виде «0700 11 12 22» дал ТРЕТЬЮ запись того же человека.
--
-- Второе важнее первого: простой unique по тексту телефона обходится
-- форматированием, и такое ограничение хуже отсутствующего — создаёт
-- ложное чувство защиты. Поэтому нормализация, и уникальность по ней.
--
-- Раздел контактов в кабинете — ровно то место, где дубликаты и заводятся,
-- поэтому правило вводится вместе с ним, а не после.

-- ---------------------------------------------------------------------------
-- Нормализация номера
-- ---------------------------------------------------------------------------
-- Для Кыргызстана: +996 700 11 12 22, 0700111222 и 700111222 — один номер.
-- Иностранные оставляем как цифры: угадывать их план нумерации не берёмся.

create or replace function app.normalize_phone(p_phone text) returns text
  language sql immutable as $$
  with d as (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as v)
  select case
    when length(d.v) = 12 and left(d.v, 3) = '996' then right(d.v, 9)
    when length(d.v) = 10 and left(d.v, 1) = '0'   then right(d.v, 9)
    else d.v
  end
  from d
$$;

comment on function app.normalize_phone is
  'Приводит номер к сопоставимому виду. +996700111222, 0700111222 и 700111222 дают один результат — иначе уникальность обходится форматированием.';

alter table contact_phones
  add column phone_normalized text
  generated always as (app.normalize_phone(phone)) stored;

-- Один номер — один контакт. Это и есть «один человек — одна запись».
--
-- КОМПРОМИСС: номер, которым реально пользуются двое (супруги, рабочий
-- телефон на двоих), придётся записать одному контакту, а второму дать
-- другой номер или обойтись без него. Правило из задания сформулировано
-- однозначно, и на нём держится смысл roles[]: роли это флаги одной записи,
-- а не повод завести вторую.
create unique index contact_phones_one_contact_per_phone_idx
  on contact_phones (phone_normalized)
  where phone_normalized <> '';

create index contact_phones_normalized_idx on contact_phones (phone_normalized);

-- Чтобы клиенту не приходилось знать свой agent_id.
alter table contacts alter column owner_agent_id set default app.current_agent_id();

-- ---------------------------------------------------------------------------
-- Поиск контакта по телефону перед созданием
-- ---------------------------------------------------------------------------
-- Без этого правило «один человек — одна запись» наказывает за дубликат, но
-- не помогает его избежать: агент узнаёт о существующей записи только из
-- ошибки.
--
-- ЧТО ОТДАЁМ. Здесь сталкиваются два правила: «одна запись» требует сказать,
-- что контакт существует, а инвариант 4 закрывает чужие контакты. Отдаём
-- минимум, который решает задачу: факт существования и ИМЯ КОЛЛЕГИ, у
-- которого контакт. Имя самого контакта — только если инвариант 4 его и так
-- открывает. Агент уже держит этот номер в руках (он его и ввёл), поэтому
-- узнаёт он ровно одно: с этим человеком работает такой-то коллега, надо
-- договориться, а не плодить вторую запись.

create or replace function find_contact_by_phone(p_phone text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_norm text := app.normalize_phone(p_phone);
  v_row  record;
begin
  perform app.require_agent();

  if v_norm = '' then
    return jsonb_build_object('found', false);
  end if;

  select c.id, c.name, c.owner_agent_id, ag.full_name as owner_name,
         app.can_see_contact(c.id) as visible
    into v_row
    from contact_phones cp
    join contacts c on c.id = cp.contact_id
    left join agents ag on ag.id = c.owner_agent_id
   where cp.phone_normalized = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('found', false, 'normalized', v_norm);
  end if;

  return jsonb_build_object(
    'found',      true,
    'normalized', v_norm,
    'owner_name', v_row.owner_name,
    'visible',    v_row.visible,
    -- Имя и ссылка — только тому, кому контакт и так открыт.
    'contact_id', case when v_row.visible then v_row.id   else null end,
    'name',       case when v_row.visible then v_row.name else null end
  );
end $$;

comment on function find_contact_by_phone is
  'Проверка перед созданием контакта. Отдаёт факт существования и коллегу, у которого контакт; имя — только если инвариант 4 его открывает.';

grant execute on function find_contact_by_phone(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Роли: почему НЕ требуем хотя бы одну
-- ---------------------------------------------------------------------------
-- Здесь я сначала поставил ограничение
--   check (array_length(roles, 1) >= 1)
-- и оно оказалось неверным дважды.
--
-- Во-первых, оно ничего не проверяло: array_length('{}', 1) даёт NULL,
-- NULL >= 1 тоже NULL, а CHECK при NULL считается выполненным. Контакт без
-- ролей проходил беспрепятственно. Декоративное ограничение хуже
-- отсутствующего: оно создаёт уверенность, которой нет.
--
-- Во-вторых, его не должно быть и в рабочем виде. Роли контакта по заданию
-- это собственник, покупатель, арендатор, арендодатель. Но у объекта бывает
-- «контактное лицо» и «доверенное лицо» — это роли СВЯЗИ
-- (object_ownerships.role), а не контакта. Человек, который всего лишь
-- контактное лицо по объекту, ни одной роли контакта не имеет, и запретить
-- его запись значило бы запретить случай из самого задания.
--
-- Поэтому контакт без ролей допустим. В списке он виден как «роль не
-- указана» — чтобы было заметно, а не чтобы блокировать.

-- ---------------------------------------------------------------------------
-- Список и карточка контакта
-- ---------------------------------------------------------------------------
-- Телефоны собираются подзапросом: у контакта их несколько, и join
-- размножил бы строку контакта.

create or replace view contact_list_v
  with (security_invoker = true) as
select
  c.id,
  c.kind,
  c.name,
  c.telegram,
  c.source,
  c.roles,
  c.note,
  c.created_at,
  c.owner_agent_id,
  ag.full_name as owner_name,
  (c.owner_agent_id = app.current_agent_id()) as mine,

  (select string_agg(cp.phone, ', ' order by cp.is_primary desc, cp.phone)
     from contact_phones cp where cp.contact_id = c.id)            as phones,

  (select count(*) from object_ownerships oo where oo.contact_id = c.id) as objects_count,
  (select count(*) from requirements r where r.contact_id = c.id)        as requirements_count,
  (select count(*) from requirements r
    where r.contact_id = c.id
      and r.status not in ('closed', 'lost'))                            as open_requirements
from contacts c
left join agents ag on ag.id = c.owner_agent_id;

comment on view contact_list_v is
  'Список контактов. Виден только тем, кому инвариант 4 отдаёт сам контакт, поэтому отдельной фильтрации не нужно.';

grant select on contact_list_v to authenticated;
revoke all   on contact_list_v from anon;

-- Объекты контакта: что он продаёт или сдаёт.
create or replace view contact_objects_v
  with (security_invoker = true) as
select
  oo.contact_id,
  oo.role      as ownership_role,
  oo.share,
  o.id         as object_id,
  o.address,
  o.deal_type,
  o.price,
  o.currency,
  o.publication_state,
  m.id         as active_mandate_id,
  m.contract_confirmed
from object_ownerships oo
join objects o on o.id = oo.object_id
left join mandates m on m.object_id = o.id and m.status = 'active';

grant select on contact_objects_v to authenticated;
revoke all   on contact_objects_v from anon;
