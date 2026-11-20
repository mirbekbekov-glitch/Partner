-- 0028_leads.sql
-- Заявка с публичного каталога.
--
-- Это первая запись в базу от НЕИЗВЕСТНОГО: до сих пор писать могли только
-- одобренные агенты. Поэтому поверхность сведена к одной функции
-- submit_lead(), а таблица заявок анониму не выдана вовсе — ни на чтение,
-- ни на запись. Всё, что он может: оставить заявку на ОПУБЛИКОВАННЫЙ объект.
--
-- Что проверяется внутри функции, а не в форме: форму обойти тривиально,
-- запрос уходит прямо в PostgREST.
--   • объект существует и опубликован (иначе — «не найдено», без намёка на
--     то, что черновик с таким id есть);
--   • имя и сообщение в разумных границах;
--   • телефон похож на телефон;
--   • повтор той же пары «телефон + объект» за сутки не создаёт второй
--     заявки, а возвращает прежнюю: человек нажал дважды, агент не должен
--     получить два звонка;
--   • частота: не больше пяти заявок с одного номера в час и не больше
--     тридцати на один объект в час.
--
-- Телефон заявителя — такой же чувствительный, как телефон собственника, и
-- живёт по тому же правилу: видит тот, кто ведёт объект, и админ.

create type lead_status as enum (
  'new',      -- поступила, никто не взял
  'in_work',  -- агент взял в работу
  'done',     -- отработана
  'spam'      -- мусор
);

create table leads (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references objects (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  phone       text not null,
  -- Нормализованный номер нужен для склейки повторов и подсчёта частоты.
  -- Та же функция, что у контактов (0021): «0700 11 22 33» и «+996700112233»
  -- должны считаться одним номером, иначе ограничение обходится форматом.
  phone_normalized text generated always as (app.normalize_phone(phone)) stored,
  message     text check (message is null or length(message) <= 2000),
  status      lead_status not null default 'new',
  -- Кто взял заявку. NULL — ещё никто.
  agent_id    uuid references agents (id) on delete set null,
  -- Задача, заведённая по заявке. Удалили задачу — заявка остаётся.
  activity_id uuid references activities (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table leads is
  'Заявки с публичного каталога. Пишутся ТОЛЬКО через submit_lead(); '
  'телефон заявителя виден тем же, кто ведёт объект, и админу.';

create index leads_object_idx on leads (object_id, created_at desc);
create index leads_status_idx on leads (status, created_at desc);
create index leads_phone_idx  on leads (phone_normalized, created_at desc);

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------
alter table leads enable row level security;

-- Кто ведёт объект, тот и видит заявки по нему. Намеренно тот же предикат,
-- что у правки объекта (0015): иначе вышло бы, что снять объект с публикации
-- агент не может, а читать телефоны его заявителей — может.
create policy leads_read on leads for select to authenticated
  using (app.can_edit_object(object_id));

grant select on leads to authenticated;
revoke all on leads from anon;
-- Записи напрямую нет ни у кого: только функции ниже.
revoke insert, update, delete on leads from authenticated;

-- Инвариант 7: заявка — такая же сущность, её изменения тоже в журнале.
create trigger zz_audit_leads after insert or update or delete on leads
  for each row execute function app.write_audit('lead', 'id');
create trigger a_touch_leads before update on leads
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Приём заявки
-- ---------------------------------------------------------------------------

create or replace function app.submit_lead(
  p_object_id uuid,
  p_name      text,
  p_phone     text,
  p_message   text default null
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_msg     text := nullif(btrim(coalesce(p_message, '')), '');
  v_norm    text := app.normalize_phone(p_phone);
  v_agent   uuid;
  v_addr    text;
  v_act     uuid;
  v_id      uuid;
begin
  -- Объект должен быть опубликован. Проверка и ограничивает права, и не
  -- выдаёт существование черновика: ответ один и тот же.
  select o.address into v_addr
    from objects o
   where o.id = p_object_id and o.publication_state = 'published';
  if v_addr is null then
    raise exception 'NOT_FOUND: объект не найден или снят с публикации'
      using errcode = 'no_data_found';
  end if;

  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'BAD_INPUT: имя обязательно и не длиннее 120 символов'
      using errcode = 'check_violation';
  end if;
  if v_msg is not null and length(v_msg) > 2000 then
    raise exception 'BAD_INPUT: сообщение не длиннее 2000 символов'
      using errcode = 'check_violation';
  end if;
  -- normalize_phone оставляет только цифры и приводит к виду 996XXXXXXXXX.
  if v_norm is null or length(v_norm) < 9 then
    raise exception 'BAD_PHONE: телефон не похож на номер'
      using errcode = 'check_violation';
  end if;

  -- Повтор той же пары за сутки: возвращаем прежнюю заявку.
  select l.id into v_id
    from leads l
   where l.object_id = p_object_id
     and l.phone_normalized = v_norm
     and l.created_at > now() - interval '24 hours'
   order by l.created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Частота. Числа подобраны так, чтобы живой интерес проходил, а перебор
  -- упирался: пять заявок в час с одного номера — уже не человек.
  if (select count(*) from leads l
       where l.phone_normalized = v_norm
         and l.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'TOO_MANY: слишком много заявок с этого номера, попробуйте позже'
      using errcode = 'check_violation';
  end if;
  if (select count(*) from leads l
       where l.object_id = p_object_id
         and l.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'TOO_MANY: слишком много заявок по этому объекту, попробуйте позже'
      using errcode = 'check_violation';
  end if;

  insert into leads (object_id, name, phone, message)
  values (p_object_id, v_name, p_phone, v_msg)
  returning id into v_id;

  -- Задача тому, кто ведёт объект. Заявка, о которой никому не сказали,
  -- бесполезна, а задачи у агента уже есть — вместе с напоминаниями (0024).
  select m.listing_agent_id into v_agent
    from mandates m
   where m.object_id = p_object_id and m.status = 'active'
   limit 1;
  if v_agent is null then
    select o.created_by_agent_id into v_agent from objects o where o.id = p_object_id;
  end if;

  if v_agent is not null then
    -- is_shared = false: в задаче стоит имя заявителя, и видеть её должен
    -- тот, кто ведёт объект, а не все коллеги. Телефон в текст не кладём —
    -- он живёт в заявке, под своим правилом видимости.
    insert into activities (kind, entity_type, entity_id, agent_id, body, due_at, is_shared)
    values ('call', 'object', p_object_id, v_agent,
            format('Заявка с сайта по «%s»: %s. Телефон — в разделе «Заявки».', v_addr, v_name),
            now() + interval '2 hours', false)
    returning id into v_act;

    update leads set activity_id = v_act where id = v_id;
  end if;

  return v_id;
end $$;

comment on function app.submit_lead is
  'Единственный путь записи для анонима. Проверки живут здесь, а не в форме: '
  'форму обойти тривиально, запрос уходит прямо в PostgREST.';

-- ---------------------------------------------------------------------------
-- Работа с заявкой в кабинете
-- ---------------------------------------------------------------------------

create or replace function app.set_lead_status(p_lead_id uuid, p_status lead_status)
  returns leads
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r leads; v_obj uuid;
begin
  perform app.require_agent();

  select object_id into v_obj from leads where id = p_lead_id;
  if v_obj is null then
    raise exception 'заявка % не найдена', p_lead_id using errcode = 'no_data_found';
  end if;
  if not app.can_edit_object(v_obj) then
    raise exception 'FORBIDDEN: заявки ведёт тот, кто ведёт объект'
      using errcode = '42501';
  end if;

  update leads
     set status   = p_status,
         -- Взял в работу — значит за заявкой закреплён человек.
         agent_id = case when p_status = 'in_work' and agent_id is null
                         then app.current_agent_id() else agent_id end
   where id = p_lead_id
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Публичные обёртки: PostgREST видит только схему public
-- ---------------------------------------------------------------------------

-- security definer, в отличие от остальных обёрток: они зовутся агентом, а
-- у роли authenticated есть право на схему app. У анонима его нет и быть не
-- должно — иначе ему открылись бы и остальные функции схемы. Без definer
-- заявка падала с «permission denied for schema app».
create or replace function submit_lead(
  p_object_id uuid, p_name text, p_phone text, p_message text default null
) returns uuid
  language sql security definer set search_path = public, pg_temp as $$
  select app.submit_lead(p_object_id, p_name, p_phone, p_message)
$$;

create or replace function set_lead_status(p_lead_id uuid, p_status lead_status)
  returns leads
  language sql as $$
  select * from app.set_lead_status(p_lead_id, p_status)
$$;

grant execute on function app.submit_lead(uuid, text, text, text) to anon, authenticated;
grant execute on function app.set_lead_status(uuid, lead_status) to authenticated;

-- Заявку оставляет кто угодно, статус меняет только вошедший агент.
revoke execute on function set_lead_status(uuid, lead_status) from public;
grant   execute on function set_lead_status(uuid, lead_status) to authenticated;

-- ---------------------------------------------------------------------------
-- Заодно: EXECUTE на публичных функциях по умолчанию у PUBLIC
-- ---------------------------------------------------------------------------
-- 0025 снял это со схемы app, но схему public не трогал, и анониму остались
-- доступны все обёртки — publish_object, close_deal, approve_agent. Дырой
-- это не было: каждая начинается с проверки прав и отвечает анониму
-- «FORBIDDEN» (проверено). Но единственной преградой была проверка ВНУТРИ
-- функции — стоит завести обёртку без неё, и она окажется открыта миру.
-- Теперь право на вызов выдаётся явно, а не достаётся по умолчанию.
--
-- submit_lead — единственное исключение, и оно описано выше.

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname <> 'submit_lead'
       -- Функции расширений не трогаем: права им раздаёт расширение.
       and not exists (select 1 from pg_depend d
                        where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    -- Служебным функциям рассылки права выданы точечно в 0025:
    -- authenticated им не нужен.
    if f.proname not in ('enqueue_due_reminders', 'claim_notifications', 'mark_notification') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
