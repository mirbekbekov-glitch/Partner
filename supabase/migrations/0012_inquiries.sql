-- 0012_inquiries.sql
-- ИНВАРИАНТ 9: обращение закрывается ровно одним способом.
--
-- До этой миграции поток входящих жил вне платформы: потребность появлялась в
-- системе уже готовой, и на вопрос «сколько звонков дала реклама на lalafo и
-- во что они превратились» ответить было нечем. Реестр обращений с источником
-- и видимой историей отказов есть у CRM1RS и ReCRM; у нас его не было вовсе.
--
-- Обращение — это сырой вход: звонок, сообщение, заявка с сайта. У него ровно
-- четыре исхода, и инвариант в том, что исход один и он окончательный:
--
--   qualified  — разобрались, продолжаем работу (промежуточный);
--   converted  — превратилось в потребность ИЛИ в объект, ровно в одно;
--   rejected   — отказ с причиной;
--   spam       — мусор, тоже с причиной.
--
-- Закрытое обращение не переоткрывается и ссылку не меняет: иначе воронка по
-- каналам пересобиралась бы задним числом, и отчёт по рекламе врал бы.

create type inquiry_channel as enum (
  'phone', 'whatsapp', 'telegram', 'site', 'lalafo', 'house_kg',
  'walk_in', 'referral', 'other');

-- Чего хочет обратившийся. Спрос идёт в потребность, предложение — в объект.
create type inquiry_intent as enum ('demand', 'supply', 'unknown');

create type inquiry_status as enum
  ('new', 'qualified', 'converted', 'rejected', 'spam');

create table inquiries (
  id              uuid primary key default gen_random_uuid(),

  channel         inquiry_channel not null,
  -- Конкретный источник внутри канала: «объявление на lalafo», «визитка»,
  -- utm-метка. Именно он отвечает на вопрос, какая реклама окупается.
  source          text,
  intent          inquiry_intent not null default 'unknown',

  received_at     timestamptz not null default now(),
  received_by_agent_id uuid not null references agents (id) on delete restrict,

  contact_name    text,
  -- Нормализуется, но мягко: см. app.normalize_inquiry_phone.
  contact_phone   text,
  body            text,

  -- По какому объекту звонили, если обращение пришло с рекламы объекта.
  -- Это не исход, а контекст: звонок по объекту часто кончается другим.
  about_object_id uuid references objects (id) on delete set null,

  status          inquiry_status not null default 'new',

  -- Исход. Ровно одна из двух ссылок, и только у converted.
  requirement_id  uuid references requirements (id) on delete restrict,
  object_id       uuid references objects      (id) on delete restrict,
  contact_id      uuid references contacts     (id) on delete set null,

  rejection_reason text,
  closed_at       timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Отказ обязан иметь причину: иначе аналитика отвала бессмысленна,
  -- ровно как у подбора.
  constraint inquiries_rejection_has_reason
    check (status not in ('rejected', 'spam')
           or length(btrim(coalesce(rejection_reason, ''))) > 0),

  -- Закрытое обращение имеет дату закрытия, открытое — не имеет.
  constraint inquiries_closed_at_matches_status
    check ((status in ('converted', 'rejected', 'spam')) = (closed_at is not null)),

  -- Ровно один исход: либо потребность, либо объект, и только у converted.
  constraint inquiries_one_outcome
    check (
      case status
        when 'converted' then
          (requirement_id is not null) <> (object_id is not null)
        else requirement_id is null and object_id is null
      end)
);

comment on table inquiries is
  'Инвариант 9. Сырой вход: звонок, сообщение, заявка. Закрывается ровно одним исходом, и исход окончателен.';
comment on column inquiries.source is
  'Конкретный источник внутри канала. На нём держится отчёт по окупаемости рекламы.';
comment on column inquiries.about_object_id is
  'Объект, по рекламе которого позвонили. Контекст, а не исход.';

create index inquiries_status_idx   on inquiries (status, received_at desc);
create index inquiries_agent_idx    on inquiries (received_by_agent_id, received_at desc);
create index inquiries_channel_idx  on inquiries (channel, received_at desc);
create index inquiries_open_idx     on inquiries (received_at)
  where status in ('new', 'qualified');

-- ---------------------------------------------------------------------------
-- Телефон обращения: нормализуем, но не отвергаем
-- ---------------------------------------------------------------------------
-- Сознательная асимметрия с агентами. У агента номер — ключ личности, и мусор
-- там недопустим (инвариант 6). У обращения номер — сырые данные со слуха:
-- отказать во всей записи из-за опечатки значит потерять лид. Поэтому
-- разобранный номер приводится к E.164, а неразобранный остаётся как есть.

create or replace function app.normalize_inquiry_phone() returns trigger
  language plpgsql as $$
declare v text;
begin
  if new.contact_phone is null or btrim(new.contact_phone) = '' then
    new.contact_phone := null;
    return new;
  end if;

  v := app.normalize_phone(new.contact_phone);
  new.contact_phone := coalesce(v, btrim(new.contact_phone));
  return new;
end $$;

create trigger a_inquiry_phone
  before insert or update of contact_phone on inquiries
  for each row execute function app.normalize_inquiry_phone();

-- ---------------------------------------------------------------------------
-- Инвариант 9: исход окончателен
-- ---------------------------------------------------------------------------

create or replace function app.check_inquiry_outcome() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req requirements%rowtype;
  v_obj objects%rowtype;
begin
  if tg_op = 'UPDATE' and old.status in ('converted', 'rejected', 'spam') then
    -- Единственное, что разрешено после закрытия, — дописать контакт:
    -- кто звонил, выясняется и позже.
    if new.status is distinct from old.status
       or new.requirement_id is distinct from old.requirement_id
       or new.object_id is distinct from old.object_id
       or new.rejection_reason is distinct from old.rejection_reason
       or new.channel is distinct from old.channel
       or new.source is distinct from old.source then
      raise exception
        'INVARIANT_9: обращение уже закрыто как %, исход не переписывается', old.status
        using errcode = 'check_violation',
              hint = 'Заведите новое обращение, если клиент обратился снова.';
    end if;
  end if;

  if new.status = 'converted' then
    -- Названо здесь, а не оставлено ограничению схемы: триггер срабатывает
    -- раньше, и без этой проверки наружу уходило «объект <NULL> не
    -- существует» вместо внятной причины.
    if (new.requirement_id is null) = (new.object_id is null) then
      raise exception
        'INVARIANT_9: закрыть обращение можно ровно одним исходом — потребностью или объектом'
        using errcode = 'check_violation';
    end if;

    -- Спрос превращается в потребность, предложение — в объект. Иначе
    -- воронка по намерению считала бы одно, а ссылки вели в другое.
    if new.requirement_id is not null and new.intent = 'supply' then
      raise exception
        'INVARIANT_9: обращение с намерением «предложение» нельзя закрыть потребностью'
        using errcode = 'check_violation';
    end if;
    if new.object_id is not null and new.intent = 'demand' then
      raise exception
        'INVARIANT_9: обращение с намерением «спрос» нельзя закрыть объектом'
        using errcode = 'check_violation';
    end if;

    if new.requirement_id is not null then
      select * into v_req from requirements where id = new.requirement_id;
      if not found then
        raise exception 'INVARIANT_9: потребность % не существует', new.requirement_id
          using errcode = 'foreign_key_violation';
      end if;
    else
      select * into v_obj from objects where id = new.object_id;
      if not found then
        raise exception 'INVARIANT_9: объект % не существует', new.object_id
          using errcode = 'foreign_key_violation';
      end if;
    end if;
  end if;

  return new;
end $$;

create trigger b_inquiry_outcome
  before insert or update on inquiries
  for each row execute function app.check_inquiry_outcome();

-- ---------------------------------------------------------------------------
-- Журнал и updated_at (инвариант 7)
-- ---------------------------------------------------------------------------

create trigger a_touch_inquiries
  before update on inquiries
  for each row execute function app.touch_updated_at();

create trigger zz_audit_inquiries
  after insert or update or delete on inquiries
  for each row execute function app.write_audit('inquiry', 'id');

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------
-- Обращение видит принявший агент и админ, а не вся команда: в body свободным
-- текстом окажется и телефон, и «звонил сосед собственника». Это та же логика,
-- что у activities. Руководителю история отказов открыта целиком — ради этого
-- реестр и заводится.

alter table inquiries enable row level security;

create policy inquiries_read on inquiries for select
  using (received_by_agent_id = app.current_agent_id() or app.is_admin());

create policy inquiries_insert on inquiries for insert
  with check (received_by_agent_id = app.current_agent_id() or app.is_admin());

create policy inquiries_update on inquiries for update
  using (received_by_agent_id = app.current_agent_id() or app.is_admin())
  with check (received_by_agent_id = app.current_agent_id() or app.is_admin());

create policy inquiries_delete on inquiries for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function register_inquiry(
  p_channel       inquiry_channel,
  p_intent        inquiry_intent default 'unknown',
  p_source        text default null,
  p_contact_name  text default null,
  p_contact_phone text default null,
  p_body          text default null,
  p_about_object  uuid default null
) returns inquiries
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       inquiries;
begin
  insert into inquiries (channel, intent, source, contact_name, contact_phone,
                         body, about_object_id, received_by_agent_id)
  values (p_channel, p_intent, p_source, p_contact_name, p_contact_phone,
          p_body, p_about_object, v_agent)
  returning * into r;
  return r;
end $$;

comment on function register_inquiry is
  'Зафиксировать обращение. Принявший агент это текущий агент: передать чужого нельзя.';

create or replace function qualify_inquiry(p_inquiry_id uuid)
  returns inquiries
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r inquiries;
begin
  perform app.require_agent();

  update inquiries set status = 'qualified'
   where id = p_inquiry_id and status = 'new'
  returning * into r;

  if r.id is null then
    raise exception 'обращение % не найдено или уже не новое', p_inquiry_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- Закрытие исходом. Ровно одна ссылка; какая именно, проверяет инвариант.
create or replace function convert_inquiry(
  p_inquiry_id     uuid,
  p_requirement_id uuid default null,
  p_object_id      uuid default null
) returns inquiries
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_contact uuid;
  r         inquiries;
begin
  perform app.require_agent();

  if (p_requirement_id is null) = (p_object_id is null) then
    raise exception
      'INVARIANT_9: нужен ровно один исход — потребность или объект'
      using errcode = 'check_violation';
  end if;

  -- Контакт выводится на сервере из того, во что обращение превратилось:
  -- клиенту его передавать незачем, а расхождение было бы незаметным.
  if p_requirement_id is not null then
    select contact_id into v_contact from requirements where id = p_requirement_id;
  end if;

  update inquiries
     set status         = 'converted',
         requirement_id = p_requirement_id,
         object_id      = p_object_id,
         contact_id     = coalesce(v_contact, contact_id),
         closed_at      = now()
   where id = p_inquiry_id
  returning * into r;

  if r.id is null then
    raise exception 'обращение % не найдено', p_inquiry_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function reject_inquiry(
  p_inquiry_id uuid,
  p_reason     text,
  p_spam       boolean default false
) returns inquiries
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r inquiries;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'INVARIANT_9: причина отказа обязательна'
      using errcode = 'check_violation';
  end if;

  update inquiries
     set status           = case when p_spam then 'spam'::inquiry_status
                                 else 'rejected'::inquiry_status end,
         rejection_reason = p_reason,
         closed_at        = now()
   where id = p_inquiry_id
  returning * into r;

  if r.id is null then
    raise exception 'обращение % не найдено', p_inquiry_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Данные для кабинета
-- ---------------------------------------------------------------------------

create or replace view inquiries_v
  with (security_invoker = true) as
select
  i.id,
  i.channel,
  i.source,
  i.intent,
  i.status,
  i.received_at,
  i.closed_at,
  i.contact_name,
  i.contact_phone,
  i.body,
  i.rejection_reason,
  i.received_by_agent_id,
  ag.full_name as received_by_name,
  i.about_object_id,
  o.address    as about_object_address,
  i.requirement_id,
  i.object_id,
  (i.status in ('new', 'qualified')) as is_open,
  -- Сколько обращение ждёт ответа. Главный показатель входа: лид, который
  -- лежит третий день, уже не лид.
  case when i.status in ('new', 'qualified')
       then now() - i.received_at
       else i.closed_at - i.received_at
  end as age
from inquiries i
left join agents  ag on ag.id = i.received_by_agent_id
left join objects o  on o.id = i.about_object_id;

comment on view inquiries_v is
  'Обращения для кабинета. age — время до ответа у закрытых и время ожидания у открытых.';

-- Воронка по каналам: ради этого реестр и нужен. Доступна тем же, кому
-- доступны сами обращения, поэтому агент видит свою воронку, админ — всю.
create or replace view inquiry_funnel_v
  with (security_invoker = true) as
select
  channel,
  source,
  count(*)                                          as total,
  count(*) filter (where status in ('new', 'qualified')) as open,
  count(*) filter (where status = 'converted')      as converted,
  count(*) filter (where status = 'rejected')       as rejected,
  count(*) filter (where status = 'spam')           as spam,
  round(100.0 * count(*) filter (where status = 'converted')
        / nullif(count(*) filter (where status <> 'spam'), 0), 1) as conversion_pct
from inquiries
group by channel, source;

comment on view inquiry_funnel_v is
  'Отдача каналов. Спам исключён из знаменателя конверсии: он не входящий поток, а шум.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on inquiries to authenticated;
grant select on inquiries_v, inquiry_funnel_v to authenticated;
revoke all on inquiries, inquiries_v, inquiry_funnel_v from anon;

grant execute on function
  register_inquiry(inquiry_channel, inquiry_intent, text, text, text, text, uuid),
  qualify_inquiry(uuid),
  convert_inquiry(uuid, uuid, uuid),
  reject_inquiry(uuid, text, boolean)
  to authenticated;
