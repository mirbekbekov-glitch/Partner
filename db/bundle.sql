-- =====================================================================
-- Платформа профессионалов: вся схема одним файлом
--
-- Собрано из supabase/migrations/ скриптом db/bundle.sh. Этот файл нужен
-- ровно для одного случая: применить схему вручную через SQL Editor в
-- панели Supabase, когда CLI недоступен. В остальных случаях применяйте
-- миграции по отдельности: supabase db push.
--
-- Порядок файлов важен и сохранён: миграции опираются друг на друга.
-- Применять целиком, одним запуском.
--
-- Схема auth и роли anon/authenticated/service_role на Supabase уже есть,
-- поэтому db/local_supabase_stub.sql сюда НЕ включён — он только для
-- локального Postgres.
--
-- После применения обязательны две настройки в панели, без них вход не
-- работает: Redirect URLs и шаблон письма Magic Link. См. README, раздел
-- «Обязательная настройка Supabase для входа».
-- =====================================================================

-- ==== 0001_foundation.sql =======================================

-- 0001_foundation.sql
-- Схема агентства недвижимости: основание.
-- Справочники значений, таблица агентов, помощники текущего пользователя.
--
-- Один человек — один аккаунт (инвариант 6): якорь — agents.telegram_id UNIQUE.
-- Владение объектами висит на стабильном agents.id, поэтому повторный вход
-- через Telegram не создаёт дубликат и не теряет владение.

create extension if not exists "pgcrypto";

create schema if not exists app;
comment on schema app is 'Внутренние помощники и проверки инвариантов. Не для прямого доступа клиента.';

-- ---------------------------------------------------------------------------
-- Справочники
-- ---------------------------------------------------------------------------

create type contact_kind       as enum ('person', 'company');
create type contact_role       as enum ('owner', 'buyer', 'tenant', 'landlord');
create type deal_type          as enum ('rent', 'sale');
create type object_kind        as enum ('flat', 'room', 'house', 'townhouse', 'land', 'commercial', 'garage');
create type publication_state  as enum ('draft', 'published', 'withdrawn');
create type ownership_role     as enum ('owner', 'co_owner', 'proxy', 'contact_person');
create type mandate_kind       as enum ('exclusive', 'non_exclusive');
create type agent_role         as enum ('agent', 'admin');
create type agent_status       as enum ('pending', 'approved', 'blocked');

-- Инвариант 1 и пункт переноса: 'requires_confirmation' НЕ отдельная ступень
-- перед активностью. Договор, не подтверждённый документом, остаётся активным
-- мандатом с contract_confirmed = false — иначе перенос существующих объектов
-- снял бы весь каталог с публикации.
create type mandate_status     as enum ('active', 'expired', 'terminated', 'closed_by_deal');

create type requirement_status as enum ('new', 'qualified', 'in_showings', 'in_deal', 'closed', 'lost');
create type match_status       as enum ('proposed', 'interested', 'showing_scheduled', 'showing_done', 'bargaining', 'rejected', 'in_deal');
create type deal_status        as enum ('deposit', 'documents', 'signing', 'settlement', 'closed', 'failed');
create type activity_kind      as enum ('call', 'showing', 'task', 'note', 'message');
create type publication_channel as enum ('site', 'mini_app', 'lalafo', 'house_kg');
create type channel_status     as enum ('exported', 'updated', 'error', 'withdrawn');
create type audit_action       as enum ('insert', 'update', 'delete');

-- ---------------------------------------------------------------------------
-- Агенты
-- ---------------------------------------------------------------------------

create table agents (
  id            uuid primary key default gen_random_uuid(),
  -- Привязка к существующей Telegram-идентичности. UNIQUE — это и есть
  -- инвариант 6 на уровне схемы: второй аккаунт на тот же Telegram невозможен.
  telegram_id   bigint      not null unique,
  -- Supabase auth.users.id. Заполняется при первом входе.
  auth_user_id  uuid                 unique,
  full_name     text        not null,
  phone         text,
  role          agent_role  not null default 'agent',
  -- CRM открывается только агентам со статусом «одобрен».
  status        agent_status not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column agents.telegram_id is
  'Инвариант 6: одна Telegram-идентичность — один аккаунт. Вход делает upsert по этому ключу, никогда insert новой строки.';

create index agents_status_idx on agents (status) where status = 'approved';

-- ---------------------------------------------------------------------------
-- Кто сейчас работает
-- ---------------------------------------------------------------------------

-- В Supabase auth.uid() берёт sub из request.jwt.claims. Тесты выставляют тот
-- же GUC, поэтому проверяется ровно тот путь, который работает в продакшене.
create or replace function app.current_agent_id() returns uuid
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select a.id from agents a
   where a.auth_user_id = auth.uid()
     and a.status = 'approved'
$$;

create or replace function app.is_admin() returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (
    select 1 from agents a
     where a.auth_user_id = auth.uid()
       and a.status = 'approved'
       and a.role = 'admin'
  )
$$;

-- Любое обращение из CRM требует одобренного агента.
create or replace function app.require_agent() returns uuid
  language plpgsql stable as $$
declare v uuid;
begin
  v := app.current_agent_id();
  if v is null then
    raise exception 'FORBIDDEN: требуется одобренный агент'
      using errcode = '42501';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Инвариант 6: вход по Telegram
-- ---------------------------------------------------------------------------

-- Единственный разрешённый путь создания/входа агента. ON CONFLICT по
-- telegram_id гарантирует, что повторный вход обновляет существующую строку,
-- а не создаёт вторую. agents.id не меняется, поэтому все FK на объекты,
-- мандаты и подборы остаются целыми.
create or replace function app.login_by_telegram(
  p_telegram_id  bigint,
  p_full_name    text,
  p_auth_user_id uuid default null
) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  insert into agents (telegram_id, full_name, auth_user_id)
  values (p_telegram_id, p_full_name, p_auth_user_id)
  on conflict (telegram_id) do update
     set full_name    = excluded.full_name,
         auth_user_id = coalesce(excluded.auth_user_id, agents.auth_user_id),
         updated_at   = now()
  returning * into r;
  return r;
end $$;

-- ==== 0002_core_entities.sql ====================================

-- 0002_core_entities.sql
-- Сущности агентства: контакты, объекты, собственность, мандаты,
-- потребности, подборы, сделки, активности, каналы публикации.

-- ---------------------------------------------------------------------------
-- Контакт
-- ---------------------------------------------------------------------------
-- Один человек — одна запись. Роли это флаги в массиве, а не тип записи:
-- собственник, который завтра станет покупателем, получает вторую роль,
-- а не второй контакт.

create table contacts (
  id              uuid primary key default gen_random_uuid(),
  kind            contact_kind not null default 'person',
  name            text not null check (length(btrim(name)) > 0),
  telegram        text,
  source          text,
  -- Кто привёл контакт. Основа инварианта 4: владелец всегда видит телефон.
  owner_agent_id  uuid not null references agents (id) on delete restrict,
  roles           contact_role[] not null default '{}',
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table contacts is
  'Один человек — одна запись. roles[] это флаги, дубликат на каждую роль заводить нельзя.';

create index contacts_owner_idx  on contacts (owner_agent_id);
create index contacts_roles_idx  on contacts using gin (roles);
create index contacts_name_idx   on contacts using gin (to_tsvector('simple', name));

-- ---------------------------------------------------------------------------
-- Телефоны контакта — ОТДЕЛЬНАЯ таблица, и это несущая конструкция
-- ---------------------------------------------------------------------------
-- RLS в Postgres работает на уровне строк, не колонок. Телефон в колонке
-- contacts.phones[] невозможно закрыть, оставив сам контакт открытым:
-- политика либо отдаёт строку целиком, либо не отдаёт.
-- Поэтому телефон и telegram живут здесь, со своей политикой (инвариант 4).

create table contact_phones (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references contacts (id) on delete cascade,
  phone       text not null check (length(btrim(phone)) > 0),
  is_primary  boolean not null default false,
  label       text,
  created_at  timestamptz not null default now(),
  unique (contact_id, phone)
);

comment on table contact_phones is
  'Инвариант 4. Вынесено из contacts, потому что RLS построчный: иначе телефон не закрыть, не закрыв контакт.';

create index contact_phones_contact_idx on contact_phones (contact_id);
create unique index contact_phones_one_primary_idx
  on contact_phones (contact_id) where is_primary;

-- ---------------------------------------------------------------------------
-- Объект
-- ---------------------------------------------------------------------------

create table objects (
  id                  uuid primary key default gen_random_uuid(),
  kind                object_kind not null,
  deal_type           deal_type   not null,
  address             text not null check (length(btrim(address)) > 0),
  zone                text,
  rooms               smallint check (rooms >= 0),
  area                numeric(10,2) check (area > 0),
  floor               smallint,
  floors_total        smallint,
  price               numeric(14,2) not null check (price > 0),
  currency            char(3) not null default 'USD',
  photos              jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array'),
  description         text,

  -- Публикация это состояние объекта, а не выгрузка во вторую систему.
  publication_state   publication_state not null default 'draft',

  -- Инвариант 5: ставится один раз при первой публикации и далее неизменно.
  published_at        timestamptz,
  -- Инвариант 5: обновляется при правке цены, фото или подтверждении актуальности.
  actual_at           timestamptz not null default now(),

  created_by_agent_id uuid not null references agents (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column objects.published_at is 'Инвариант 5: фиксируется при первой публикации, не меняется никогда.';
comment on column objects.actual_at    is 'Инвариант 5: обновляется правкой цены, фото или подтверждением актуальности.';

create index objects_catalog_idx on objects (deal_type, kind, price)
  where publication_state = 'published';
create index objects_zone_idx      on objects (zone)      where publication_state = 'published';
create index objects_actual_idx    on objects (actual_at desc);
create index objects_creator_idx   on objects (created_by_agent_id);
create index objects_rooms_idx     on objects (rooms)     where publication_state = 'published';

-- ---------------------------------------------------------------------------
-- Собственность: объект ↔ контакт, много-ко-многим
-- ---------------------------------------------------------------------------

create table object_ownerships (
  object_id   uuid not null references objects  (id) on delete cascade,
  contact_id  uuid not null references contacts (id) on delete restrict,
  role        ownership_role not null default 'owner',
  share       numeric(5,4) check (share > 0 and share <= 1),
  created_at  timestamptz not null default now(),
  primary key (object_id, contact_id, role)
);

create index object_ownerships_contact_idx on object_ownerships (contact_id);

-- ---------------------------------------------------------------------------
-- Мандат: договор с собственником
-- ---------------------------------------------------------------------------

create table mandates (
  id                uuid primary key default gen_random_uuid(),
  object_id         uuid not null references objects (id) on delete cascade,
  kind              mandate_kind not null default 'non_exclusive',
  valid_from        date not null default current_date,
  valid_to          date,
  start_price       numeric(14,2) not null check (start_price > 0),

  -- NULL — работает базовое правило инварианта 3 (продажа 2%, аренда 50%
  -- первого месяца). Переопределение — данными, не кодом.
  commission_rule   jsonb,

  listing_agent_id  uuid not null references agents (id) on delete restrict,

  -- Подтверждение договора. Ссылка и хэш документа, БЕЗ контактов сторон.
  contract_confirmed boolean not null default false,
  document_url      text,
  document_hash     text,

  status            mandate_status not null default 'active',
  closed_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (valid_to is null or valid_to >= valid_from)
);

comment on column mandates.contract_confirmed is
  'Перенос существующих объектов даёт мандат active + contract_confirmed=false: каталог не падает, а неподтверждённые договоры видны отдельным флагом.';
comment on column mandates.document_url is
  'Ссылка на документ. Контакты сторон здесь не хранятся сознательно.';

-- ИНВАРИАНТ 1, половина первая: у объекта не больше одного активного мандата.
-- Partial unique index, а не триггер: гонку двух одновременных вставок
-- триггер не поймает, а уникальный индекс поймает.
create unique index mandates_one_active_per_object_idx
  on mandates (object_id) where status = 'active';

create index mandates_object_idx  on mandates (object_id);
create index mandates_listing_idx on mandates (listing_agent_id);
create index mandates_expiry_idx  on mandates (valid_to) where status = 'active';

-- ---------------------------------------------------------------------------
-- Потребность
-- ---------------------------------------------------------------------------
-- У контакта их может быть несколько одновременно: никакого unique по contact_id.

create table requirements (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts (id) on delete cascade,
  deal_type    deal_type not null,
  budget_min   numeric(14,2) check (budget_min > 0),
  budget_max   numeric(14,2) check (budget_max > 0),
  zones        text[] not null default '{}',
  rooms        smallint[] not null default '{}',
  deadline     date,
  requirements_text text,
  agent_id     uuid not null references agents (id) on delete restrict,
  status       requirement_status not null default 'new',
  closed_reason text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  check (budget_min is null or budget_max is null or budget_max >= budget_min)
);

comment on table requirements is
  'У одного контакта может быть несколько одновременных потребностей — unique по contact_id намеренно отсутствует.';

create index requirements_contact_idx on requirements (contact_id, status);
create index requirements_agent_idx   on requirements (agent_id);
create index requirements_zones_idx   on requirements using gin (zones);
create index requirements_open_idx    on requirements (deal_type, status)
  where status not in ('closed', 'lost');

-- ---------------------------------------------------------------------------
-- Подбор: object × requirement. Ядро модели.
-- ---------------------------------------------------------------------------
-- Это и есть связь много-ко-многим между собственниками и клиентами.

create table matches (
  id               uuid primary key default gen_random_uuid(),
  object_id        uuid not null references objects      (id) on delete cascade,
  requirement_id   uuid not null references requirements (id) on delete cascade,
  status           match_status not null default 'proposed',
  rejection_reason text,
  showing_at       timestamptz,
  -- Агент, который ведёт клиента по этому подбору. Источник closing_agent
  -- для комиссии (инвариант 3).
  closing_agent_id uuid not null references agents (id) on delete restrict,
  created_by_agent_id uuid not null references agents (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (object_id, requirement_id),
  -- Отказ обязан иметь причину: иначе аналитика отвала бессмысленна.
  check (status <> 'rejected' or length(btrim(coalesce(rejection_reason, ''))) > 0)
);

comment on table matches is
  'Подбор object × requirement. Много-ко-многим между собственниками и клиентами. Единственный законный источник сделки (инвариант 2).';

create index matches_object_idx      on matches (object_id);
create index matches_requirement_idx on matches (requirement_id);
create index matches_closing_idx     on matches (closing_agent_id);
create index matches_showing_idx     on matches (showing_at) where showing_at is not null;

-- ---------------------------------------------------------------------------
-- Сделка
-- ---------------------------------------------------------------------------

create table deals (
  id                uuid primary key default gen_random_uuid(),

  -- ИНВАРИАНТ 2 на уровне схемы: сделки без подбора не существует.
  match_id          uuid not null references matches (id) on delete restrict,

  -- Денормализация для истории. Сверяется с match_id триггером (0005).
  object_id         uuid not null references objects      (id) on delete restrict,
  requirement_id    uuid not null references requirements (id) on delete restrict,
  mandate_id        uuid not null references mandates     (id) on delete restrict,

  listing_agent_id  uuid not null references agents (id) on delete restrict,
  closing_agent_id  uuid not null references agents (id) on delete restrict,

  final_price       numeric(14,2) check (final_price > 0),

  -- Заполняются при закрытии от final_price и дальше не пересчитываются
  -- (инвариант 3). До закрытия суммы индикативны и живут во view.
  commission_total  numeric(14,2),
  listing_share     numeric(14,2),
  closing_share     numeric(14,2),

  status            deal_status not null default 'deposit',
  failure_reason    text,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (status <> 'failed' or length(btrim(coalesce(failure_reason, ''))) > 0),
  check (status <> 'closed' or final_price is not null)
);

comment on column deals.match_id is 'Инвариант 2: NOT NULL — сделка создаётся только из подбора.';
comment on column deals.commission_total is 'Инвариант 3: фиксируется при закрытии от final_price. До закрытия смотреть deal_commission_v.';

-- Одна незавершённая сделка на подбор. Сорванную можно пересоздать.
create unique index deals_one_open_per_match_idx
  on deals (match_id) where status <> 'failed';

create index deals_object_idx   on deals (object_id);
create index deals_mandate_idx  on deals (mandate_id);
create index deals_agents_idx   on deals (listing_agent_id, closing_agent_id);
-- Используется предикатом RLS инварианта 4, поэтому индекс обязателен.
create index deals_active_idx   on deals (object_id, status)
  where status not in ('closed', 'failed');

-- ---------------------------------------------------------------------------
-- Активность
-- ---------------------------------------------------------------------------
-- Привязка к любой сущности через entity_type + entity_id. FK поставить нельзя
-- (полиморфная ссылка), поэтому тип ограничен списком, а существование строки
-- проверяет триггер в 0005.

create table activities (
  id          uuid primary key default gen_random_uuid(),
  kind        activity_kind not null,
  entity_type text not null check (entity_type in
    ('contact', 'object', 'mandate', 'requirement', 'match', 'deal')),
  entity_id   uuid not null,
  agent_id    uuid not null references agents (id) on delete restrict,
  body        text,
  due_at      timestamptz,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index activities_entity_idx on activities (entity_type, entity_id, created_at desc);
create index activities_todo_idx   on activities (agent_id, due_at) where not done;

-- ---------------------------------------------------------------------------
-- Канал публикации
-- ---------------------------------------------------------------------------

create table publication_channels (
  id            uuid primary key default gen_random_uuid(),
  object_id     uuid not null references objects (id) on delete cascade,
  channel       publication_channel not null,
  status        channel_status not null default 'exported',
  external_id   text,
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (object_id, channel)
);

create index publication_channels_object_idx on publication_channels (object_id);
create index publication_channels_stale_idx  on publication_channels (channel, last_sync_at)
  where status in ('exported', 'updated');

-- ==== 0003_audit.sql ============================================

-- 0003_audit.sql
-- ИНВАРИАНТ 7: каждое изменение сущности пишется в журнал — кто, что, когда.
--
-- Журнал ведёт одна универсальная триггерная функция, навешенная на все
-- содержательные таблицы. Писать журнал из кода приложения нельзя: любой
-- путь, который забыли обложить вызовом, молча выпадет из журнала. Триггер
-- ловит и прямые запросы к PostgREST, и psql, и фоновые задания.

create table audit_log (
  id             bigint generated always as identity primary key,
  entity_type    text   not null,
  entity_id      uuid   not null,
  action         audit_action not null,
  -- Кто. NULL означает системное действие (миграция, фоновое задание) —
  -- тогда смысл несёт actor_auth_uid или его отсутствие.
  actor_agent_id uuid references agents (id) on delete set null,
  actor_auth_uid uuid,
  -- Что. Для update только изменившиеся поля: {"price": {"from": 100, "to": 120}}.
  diff           jsonb  not null default '{}'::jsonb,
  at             timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id, at desc);
create index audit_log_actor_idx  on audit_log (actor_agent_id, at desc);
create index audit_log_at_idx     on audit_log (at desc);

comment on table audit_log is
  'Инвариант 7. Заполняется только триггером app.write_audit(), вручную не писать.';

-- ---------------------------------------------------------------------------
-- Разница двух снимков строки: только изменившиеся поля
-- ---------------------------------------------------------------------------

create or replace function app.jsonb_diff(p_old jsonb, p_new jsonb) returns jsonb
  language sql immutable as $$
  select coalesce(
    jsonb_object_agg(key, jsonb_build_object('from', p_old -> key, 'to', p_new -> key)),
    '{}'::jsonb
  )
  from (
    select jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) as key
  ) k
  where (p_old -> key) is distinct from (p_new -> key)
$$;

-- ---------------------------------------------------------------------------
-- Универсальный триггер журнала
-- ---------------------------------------------------------------------------

create or replace function app.write_audit() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_entity text := tg_argv[0];
  -- Не у каждой таблицы есть одиночный id: у object_ownerships ключ составной.
  -- Второй аргумент говорит, какую колонку брать за entity_id.
  v_keycol text := coalesce(nullif(tg_argv[1], ''), 'id');
  v_old    jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new    jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id     uuid;
  v_diff   jsonb;
  v_action audit_action;
  v_agent  uuid;
begin
  -- Агент может отсутствовать: системные операции, миграции, вход до того,
  -- как строка агента создана.
  begin
    select a.id into v_agent from agents a where a.auth_user_id = auth.uid();
  exception when others then
    v_agent := null;
  end;

  v_id := (coalesce(v_new, v_old) ->> v_keycol)::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'UPDATE' then
    v_action := 'update';
  else
    v_action := 'delete';
  end if;

  v_diff := app.jsonb_diff(v_old, v_new);

  -- updated_at из diff убираем: когда это было, уже сказано в audit_log.at,
  -- а триггер app.touch_updated_at() двигает его на КАЖДЫЙ update. Иначе
  -- «UPDATE ... set price = price» выглядел бы как настоящее изменение.
  v_diff := v_diff - 'updated_at';

  -- Пустой UPDATE журнал не засоряет.
  if tg_op = 'UPDATE' and v_diff = '{}'::jsonb then
    return new;
  end if;

  insert into audit_log (entity_type, entity_id, action, actor_agent_id, actor_auth_uid, diff)
  values (v_entity, v_id, v_action, v_agent, auth.uid(), v_diff);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Общий триггер updated_at
-- ---------------------------------------------------------------------------
-- Отдельно от actual_at: actual_at живёт по правилу инварианта 5 и обновляется
-- не на любое изменение, а только на цену, фото и подтверждение актуальности.

create or replace function app.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Навешиваем на все содержательные таблицы
-- ---------------------------------------------------------------------------
-- Список в одном месте: новая таблица — одна строка здесь, и она сразу
-- попадает и в журнал, и в updated_at.

do $$
declare
  t record;
begin
  for t in
    select * from (values
      -- таблица,               сущность,      есть updated_at, ключ для entity_id
      ('agents',              'agent',       true,  'id'),
      ('contacts',            'contact',     true,  'id'),
      ('contact_phones',      'contact_phone', false, 'id'),
      ('objects',             'object',      true,  'id'),
      -- составной ключ: в журнале сущность опознаётся по объекту,
      -- контакт и роль видны в diff
      ('object_ownerships',   'ownership',   false, 'object_id'),
      ('mandates',            'mandate',     true,  'id'),
      ('requirements',        'requirement', true,  'id'),
      ('matches',             'match',       true,  'id'),
      ('deals',               'deal',        true,  'id'),
      ('activities',          'activity',    true,  'id'),
      ('publication_channels','channel',     true,  'id')
    ) as v(tbl, entity, has_updated_at, keycol)
  loop
    execute format(
      'create trigger %I after insert or update or delete on %I
         for each row execute function app.write_audit(%L, %L)',
      'zz_audit_' || t.tbl, t.tbl, t.entity, t.keycol);

    if t.has_updated_at then
      execute format(
        'create trigger %I before update on %I
           for each row execute function app.touch_updated_at()',
        'a_touch_' || t.tbl, t.tbl);
    end if;
  end loop;
end $$;

-- ==== 0004_commission.sql =======================================

-- 0004_commission.sql
-- ИНВАРИАНТ 3: комиссия.
--
--   listing_agent  — из мандата
--   closing_agent  — из подбора
--   делёж          — 50/50
--   база           — продажа 2% цены, аренда 50% первого месяца
--   до закрытия    — индикативно, от текущей цены
--   после закрытия — от финальной цены, зафиксировано
--
-- Правило мандата (mandates.commission_rule) переопределяет базу данными,
-- а не кодом. NULL означает базовое правило.

-- Доля каждой стороны. 50/50 по заданию; вынесено в функцию, чтобы
-- возможное изменение было одной правкой, а не поиском 0.5 по кодовой базе.
create or replace function app.commission_split_ratio() returns numeric
  language sql immutable as $$ select 0.50::numeric $$;

-- ---------------------------------------------------------------------------
-- Итоговая сумма комиссии
-- ---------------------------------------------------------------------------

create or replace function app.commission_total(
  p_deal_type deal_type,
  p_price     numeric,
  p_rule      jsonb default null
) returns numeric
  language plpgsql immutable as $$
declare
  v_kind  text;
  v_value numeric;
begin
  if p_price is null or p_price <= 0 then
    return null;
  end if;

  v_kind  := p_rule ->> 'kind';
  v_value := (p_rule ->> 'value')::numeric;

  -- Базовое правило: правила нет, либо оно задано неполно.
  if v_kind is null or v_value is null then
    return round(
      case p_deal_type
        when 'sale' then p_price * 0.02   -- 2% цены
        when 'rent' then p_price * 0.50   -- 50% первого месяца
      end, 2);
  end if;

  return round(
    case v_kind
      when 'percent'      then p_price * v_value / 100.0
      when 'months_share' then p_price * v_value
      when 'fixed'        then v_value
      else
        case p_deal_type
          when 'sale' then p_price * 0.02
          when 'rent' then p_price * 0.50
        end
    end, 2);
end $$;

comment on function app.commission_total is
  'Инвариант 3. База: продажа 2% цены, аренда 50% первого месяца. commission_rule мандата переопределяет.';

-- Доля одной стороны. Остаток от округления отдаётся listing-агенту,
-- чтобы две доли всегда складывались ровно в итог.
create or replace function app.commission_shares(p_total numeric)
  returns table (listing_share numeric, closing_share numeric)
  language sql immutable as $$
  select
    p_total - round(p_total * (1 - app.commission_split_ratio()), 2),
    round(p_total * (1 - app.commission_split_ratio()), 2)
$$;

-- ---------------------------------------------------------------------------
-- Комиссия по сделке
-- ---------------------------------------------------------------------------
-- Закрытая сделка отдаёт зафиксированные суммы. Открытая считает от текущей
-- цены объекта и помечается как индикативная.

create or replace view deal_commission_v as
select
  d.id                as deal_id,
  d.object_id,
  d.mandate_id,
  d.status,
  d.listing_agent_id,
  d.closing_agent_id,
  (d.status = 'closed')                          as is_final,
  (d.status <> 'closed')                         as is_indicative,
  coalesce(d.final_price, o.price)               as basis_price,
  case when d.status = 'closed'
       then d.commission_total
       else app.commission_total(o.deal_type, o.price, m.commission_rule)
  end as commission_total,
  case when d.status = 'closed'
       then d.listing_share
       else (select s.listing_share from app.commission_shares(
               app.commission_total(o.deal_type, o.price, m.commission_rule)) s)
  end as listing_share,
  case when d.status = 'closed'
       then d.closing_share
       else (select s.closing_share from app.commission_shares(
               app.commission_total(o.deal_type, o.price, m.commission_rule)) s)
  end as closing_share
from deals d
join objects  o on o.id = d.object_id
join mandates m on m.id = d.mandate_id;

comment on view deal_commission_v is
  'Инвариант 3. is_indicative=true — сумма считается от текущей цены и будет пересчитана при закрытии. Во публичную часть не выносить.';

-- ---------------------------------------------------------------------------
-- Комиссия по подбору: всегда индикативная, сделки ещё нет
-- ---------------------------------------------------------------------------
-- Нужна кабинету: агент видит потенциал подбора до того, как сделка создана.

create or replace view match_commission_v as
select
  mt.id             as match_id,
  mt.object_id,
  mt.requirement_id,
  m.id              as mandate_id,
  m.listing_agent_id,
  mt.closing_agent_id,
  o.price           as basis_price,
  app.commission_total(o.deal_type, o.price, m.commission_rule) as commission_total,
  (select s.listing_share from app.commission_shares(
     app.commission_total(o.deal_type, o.price, m.commission_rule)) s) as listing_share,
  (select s.closing_share from app.commission_shares(
     app.commission_total(o.deal_type, o.price, m.commission_rule)) s) as closing_share
from matches mt
join objects  o on o.id = mt.object_id
left join mandates m on m.object_id = mt.object_id and m.status = 'active';

-- ==== 0005_invariants.sql =======================================

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

-- ==== 0006_rls.sql ==============================================

-- 0006_rls.sql
-- ИНВАРИАНТ 4 и разделение «публичный каталог / CRM».
--
--   Телефон собственника и клиента виден только:
--     — owner_agent контакта,
--     — агентам внутри активной сделки по этому объекту,
--     — админу.
--   Остальным агентам: объект, условия и комиссия — да, контакт — нет.
--
-- Проверяется построчными политиками, поэтому правило действует и через
-- PostgREST напрямую, не только через UI.

-- ---------------------------------------------------------------------------
-- Предикат доступа к контакту
-- ---------------------------------------------------------------------------

create or replace function app.can_see_contact(p_contact_id uuid) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    app.is_admin()
    -- Кто привёл контакт.
    or exists (
      select 1 from contacts c
       where c.id = p_contact_id
         and c.owner_agent_id = app.current_agent_id()
    )
    -- Агент внутри активной сделки, где этот контакт — собственник объекта.
    or exists (
      select 1
        from deals d
        join object_ownerships oo on oo.object_id = d.object_id
       where oo.contact_id = p_contact_id
         and d.status not in ('closed', 'failed')
         and app.current_agent_id() in (d.listing_agent_id, d.closing_agent_id)
    )
    -- Агент внутри активной сделки, где этот контакт — клиент.
    or exists (
      select 1
        from deals d
        join requirements r on r.id = d.requirement_id
       where r.contact_id = p_contact_id
         and d.status not in ('closed', 'failed')
         and app.current_agent_id() in (d.listing_agent_id, d.closing_agent_id)
    )
$$;

comment on function app.can_see_contact is
  'Инвариант 4. Подбор и назначенный показ доступа НЕ дают: нужна именно активная сделка.';

-- ---------------------------------------------------------------------------
-- Включаем RLS
-- ---------------------------------------------------------------------------

alter table agents              enable row level security;
alter table contacts            enable row level security;
alter table contact_phones      enable row level security;
alter table objects             enable row level security;
alter table object_ownerships   enable row level security;
alter table mandates            enable row level security;
alter table requirements        enable row level security;
alter table matches             enable row level security;
alter table deals               enable row level security;
alter table activities          enable row level security;
alter table publication_channels enable row level security;
alter table audit_log           enable row level security;

-- ---------------------------------------------------------------------------
-- Агенты
-- ---------------------------------------------------------------------------

create policy agents_read on agents for select
  using (app.current_agent_id() is not null or app.is_admin());

create policy agents_self_update on agents for update
  using (auth_user_id = auth.uid() or app.is_admin())
  with check (auth_user_id = auth.uid() or app.is_admin());

-- Создание агента — только через app.login_by_telegram (инвариант 6).
create policy agents_admin_write on agents for insert
  with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- Контакт и телефон — ядро инварианта 4
-- ---------------------------------------------------------------------------

create policy contacts_read on contacts for select
  using (app.can_see_contact(id));

create policy contacts_insert on contacts for insert
  with check (owner_agent_id = app.current_agent_id() or app.is_admin());

create policy contacts_update on contacts for update
  using (owner_agent_id = app.current_agent_id() or app.is_admin())
  with check (owner_agent_id = app.current_agent_id() or app.is_admin());

create policy contacts_delete on contacts for delete
  using (app.is_admin());

create policy contact_phones_read on contact_phones for select
  using (app.can_see_contact(contact_id));

create policy contact_phones_write on contact_phones for insert
  with check (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy contact_phones_update on contact_phones for update
  using (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy contact_phones_delete on contact_phones for delete
  using (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

-- ---------------------------------------------------------------------------
-- Объект: публичный каталог плюс полный доступ агентам
-- ---------------------------------------------------------------------------
-- Опубликованный объект виден всем, включая анонимов: это публичный каталог.
-- Неопубликованный — только одобренным агентам.

create policy objects_read on objects for select
  using (publication_state = 'published' or app.current_agent_id() is not null);

create policy objects_insert on objects for insert
  with check (created_by_agent_id = app.current_agent_id() or app.is_admin());

create policy objects_update on objects for update
  using (app.current_agent_id() is not null)
  with check (app.current_agent_id() is not null);

create policy objects_delete on objects for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Собственность: связь ведёт к контакту, поэтому закрыта так же
-- ---------------------------------------------------------------------------
-- Иначе object_ownerships выдала бы contact_id, и инвариант 4 обходился бы
-- join-ом в один шаг.

create policy ownerships_read on object_ownerships for select
  using (app.can_see_contact(contact_id));

create policy ownerships_write on object_ownerships for insert
  with check (exists (
    select 1 from contacts c where c.id = contact_id
      and (c.owner_agent_id = app.current_agent_id() or app.is_admin())));

create policy ownerships_update on object_ownerships for update
  using (app.can_see_contact(contact_id));

create policy ownerships_delete on object_ownerships for delete
  using (app.can_see_contact(contact_id));

-- ---------------------------------------------------------------------------
-- Мандат: условия видны всем агентам, править может listing-агент
-- ---------------------------------------------------------------------------

create policy mandates_read on mandates for select
  using (app.current_agent_id() is not null);

create policy mandates_insert on mandates for insert
  with check (listing_agent_id = app.current_agent_id() or app.is_admin());

create policy mandates_update on mandates for update
  using (listing_agent_id = app.current_agent_id() or app.is_admin())
  with check (listing_agent_id = app.current_agent_id() or app.is_admin());

create policy mandates_delete on mandates for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Потребность: условия видны агентам, контакт за ними закрыт отдельно
-- ---------------------------------------------------------------------------

create policy requirements_read on requirements for select
  using (app.current_agent_id() is not null);

create policy requirements_insert on requirements for insert
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy requirements_update on requirements for update
  using (agent_id = app.current_agent_id() or app.is_admin())
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy requirements_delete on requirements for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Подбор и сделка: видны агентам, править — участникам
-- ---------------------------------------------------------------------------

create policy matches_read on matches for select
  using (app.current_agent_id() is not null);

create policy matches_insert on matches for insert
  with check (created_by_agent_id = app.current_agent_id() or app.is_admin());

create policy matches_update on matches for update
  using (app.current_agent_id() in (closing_agent_id, created_by_agent_id) or app.is_admin());

create policy matches_delete on matches for delete
  using (app.is_admin());

create policy deals_read on deals for select
  using (app.current_agent_id() is not null);

create policy deals_insert on deals for insert
  with check (app.current_agent_id() in (listing_agent_id, closing_agent_id) or app.is_admin());

create policy deals_update on deals for update
  using (app.current_agent_id() in (listing_agent_id, closing_agent_id) or app.is_admin());

create policy deals_delete on deals for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Активность: свободный текст, в котором легко окажется телефон
-- ---------------------------------------------------------------------------
-- Поэтому автор и админ, а не вся команда: иначе заметка «звонил, +996...»
-- обошла бы инвариант 4.

create policy activities_read on activities for select
  using (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_insert on activities for insert
  with check (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_update on activities for update
  using (agent_id = app.current_agent_id() or app.is_admin());

create policy activities_delete on activities for delete
  using (agent_id = app.current_agent_id() or app.is_admin());

-- ---------------------------------------------------------------------------
-- Каналы публикации и журнал
-- ---------------------------------------------------------------------------

create policy channels_read on publication_channels for select
  using (app.current_agent_id() is not null);

create policy channels_write on publication_channels for all
  using (app.current_agent_id() is not null)
  with check (app.current_agent_id() is not null);

-- Журнал только читают, и только админ либо автор записи.
create policy audit_read on audit_log for select
  using (app.is_admin() or actor_agent_id = app.current_agent_id());

-- ---------------------------------------------------------------------------
-- Публичный каталог
-- ---------------------------------------------------------------------------
-- Единственное, что видит аноним. Ни контактов, ни комиссии, ни мандата:
-- «Не выносить комиссии в публичную часть».

create or replace view public_catalog_v
  with (security_invoker = true) as
select
  o.id, o.kind, o.deal_type, o.address, o.zone,
  o.rooms, o.area, o.floor, o.floors_total,
  o.price, o.currency, o.photos, o.description,
  o.published_at, o.actual_at
from objects o
where o.publication_state = 'published';

comment on view public_catalog_v is
  'Публичная витрина. Комиссия, контакты, мандаты и агенты сюда не попадают.';

-- ---------------------------------------------------------------------------
-- Права на роли
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app    to authenticated, service_role;

-- Аноним видит только витрину.
grant select on public_catalog_v to anon, authenticated;
grant select on objects          to anon;

-- Агент работает со всеми таблицами, объём отдаёт RLS.
grant select, insert, update, delete on
  contacts, contact_phones, objects, object_ownerships, mandates,
  requirements, matches, deals, activities, publication_channels
  to authenticated;
grant select on agents, audit_log to authenticated;
grant update on agents to authenticated;

-- Комиссия агентам, но не анонимам.
grant select on deal_commission_v, match_commission_v to authenticated;
revoke all on deal_commission_v, match_commission_v from anon;

grant execute on function
  app.current_agent_id(), app.is_admin(), app.can_see_contact(uuid),
  app.active_mandate_id(uuid), app.confirm_actual(uuid),
  app.commission_total(deal_type, numeric, jsonb), app.commission_shares(numeric),
  app.commission_split_ratio()
  to authenticated;

-- Представления комиссии должны уважать RLS вызывающего.
alter view deal_commission_v  set (security_invoker = true);
alter view match_commission_v set (security_invoker = true);

-- ==== 0007_api.sql ==============================================

-- 0007_api.sql
-- Слой доступа. Единственные пути изменения состояния, которые кабинет должен
-- вызывать. Триггеры из 0005 держат инварианты даже при прямом UPDATE, но
-- через эти функции клиенту физически нечего передать неправильно:
-- стороны комиссии, мандат и ссылки выводятся на сервере, а не приходят в запросе.

-- ---------------------------------------------------------------------------
-- Публикация объекта
-- ---------------------------------------------------------------------------

create or replace function publish_object(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if app.active_mandate_id(p_object_id) is null then
    raise exception
      'INVARIANT_1: объект нельзя опубликовать без активного мандата'
      using errcode = 'check_violation',
            hint = 'Заключите мандат с собственником, затем публикуйте.';
  end if;

  update objects set publication_state = 'published'
   where id = p_object_id
  returning * into r;

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

  update objects set publication_state = 'withdrawn'
   where id = p_object_id returning * into r;

  update publication_channels
     set status = 'withdrawn', last_sync_at = now()
   where object_id = p_object_id and status in ('exported', 'updated');

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Подбор
-- ---------------------------------------------------------------------------
-- closing_agent — тот, кто ведёт клиента, то есть текущий агент. Передать
-- чужого нельзя: инвариант 3 опирается на это поле.

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

  -- Аренду не подбирают под покупку.
  if v_obj.deal_type <> v_req.deal_type then
    raise exception 'подбор невозможен: объект это %, потребность это %',
      v_obj.deal_type, v_req.deal_type using errcode = 'check_violation';
  end if;

  if v_req.status in ('closed', 'lost') then
    raise exception 'потребность закрыта, подбор невозможен'
      using errcode = 'check_violation';
  end if;

  insert into matches (object_id, requirement_id, closing_agent_id, created_by_agent_id)
  values (p_object_id, p_requirement_id, v_agent, v_agent)
  on conflict (object_id, requirement_id) do nothing
  returning * into r;

  if r.id is null then
    select * into r from matches
     where object_id = p_object_id and requirement_id = p_requirement_id;
  end if;
  return r;
end $$;

comment on function create_match is
  'Единственный путь создания подбора. closing_agent всегда текущий агент — на этом держится инвариант 3.';

-- ---------------------------------------------------------------------------
-- Сделка из подбора (инвариант 2)
-- ---------------------------------------------------------------------------
-- Все ссылки и обе стороны комиссии выводятся из подбора и активного мандата.
-- Клиент передаёт только match_id: подменить listing_agent невозможно.

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

comment on function create_deal_from_match is
  'Инвариант 2: единственный путь создания сделки. Принимает только match_id, остальное выводит сам.';

-- ---------------------------------------------------------------------------
-- Закрытие и срыв сделки
-- ---------------------------------------------------------------------------

create or replace function close_deal(p_deal_id uuid, p_final_price numeric)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if p_final_price is null or p_final_price <= 0 then
    raise exception 'финальная цена обязательна для закрытия сделки'
      using errcode = 'check_violation';
  end if;

  -- Комиссию, мандат и потребность закрывает триггер e_deal_closed (0005):
  -- правило одно и работает даже при прямом UPDATE.
  update deals
     set status = 'closed', final_price = p_final_price, closed_at = now()
   where id = p_deal_id
  returning * into r;

  if r.id is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;

  -- Триггер дописал суммы уже после RETURNING, поэтому перечитываем.
  select * into r from deals where id = p_deal_id;
  return r;
end $$;

create or replace function fail_deal(p_deal_id uuid, p_reason text)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r deals;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'причина срыва обязательна' using errcode = 'check_violation';
  end if;

  update deals set status = 'failed', failure_reason = p_reason
   where id = p_deal_id returning * into r;

  -- Потребность возвращается в работу: сделка сорвалась, клиент остался.
  update requirements set status = 'qualified'
   where id = r.requirement_id and status = 'in_deal';

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Перенос существующих объектов (пункт 3 порядка работ)
-- ---------------------------------------------------------------------------
-- На чистой базе переносить нечего, но путь импорта нужен и сейчас: любой
-- объект, попавший в базу без мандата, обязан его получить, иначе инвариант 1
-- сделает его невидимым.
--
-- Решение по согласованию: мандат создаётся АКТИВНЫМ с contract_confirmed = false.
-- Каталог не падает, а неподтверждённые договоры видны отдельным флагом.
-- Ни одно поле объекта не меняется.

create or replace function app.backfill_missing_mandates()
  returns table (object_id uuid, mandate_id uuid)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  insert into mandates (
    object_id, kind, valid_from, valid_to, start_price,
    listing_agent_id, contract_confirmed, status
  )
  select
    o.id,
    'non_exclusive',
    coalesce(o.published_at::date, o.created_at::date, current_date),
    null,                      -- срок не выдумываем, уточняется при подтверждении
    o.price,                   -- стартовая цена = текущая, поле объекта не трогаем
    o.created_by_agent_id,     -- текущий агент сохраняется
    false,                     -- договор требует подтверждения
    'active'                   -- но каталог продолжает работать
  from objects o
  where not exists (select 1 from mandates m where m.object_id = o.id)
  returning mandates.object_id, mandates.id;
end $$;

comment on function app.backfill_missing_mandates is
  'Пункт 3: каждому объекту без мандата — активный мандат с contract_confirmed=false. Поля объекта не меняются, агент сохраняется.';

grant execute on function
  publish_object(uuid), withdraw_object(uuid),
  create_match(uuid, uuid), create_deal_from_match(uuid),
  close_deal(uuid, numeric), fail_deal(uuid, text)
  to authenticated;

-- ==== 0008_cabinet_views.sql ====================================

-- 0008_cabinet_views.sql
-- Данные для минимального UI кабинета (пункт 4):
--   на карточке объекта      — список подборов,
--   на карточке потребности  — список подборов,
--   кнопка «создать подбор»  — функция create_match() из 0007.
--
-- Представления, а не запросы в коде кабинета: инвариант 4 должен держаться
-- и при прямом обращении к PostgREST.
--
-- Ключевая деталь: контакты присоединены LEFT JOIN. Агент, которому контакт
-- не положен, видит строку подбора с пустым именем — а не теряет строку
-- целиком, как было бы при INNER JOIN. Это и есть «объект, условия и
-- комиссия да, контакт нет».

-- ---------------------------------------------------------------------------
-- Подборы на карточке объекта
-- ---------------------------------------------------------------------------

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

  -- Агент, ведущий клиента.
  mt.closing_agent_id,
  ca.full_name         as closing_agent_name,

  -- Условия потребности: видны всем агентам.
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms              as rooms_wanted,
  r.deadline,
  r.status             as requirement_status,

  -- Контакт клиента: NULL, если инвариант 4 не даёт его этому агенту.
  r.contact_id,
  c.name               as client_name,

  -- Комиссия: индикативная, пока сделки нет.
  mc.commission_total,
  mc.listing_share,
  mc.closing_share,

  -- Есть ли по этому подбору живая сделка.
  d.id                 as deal_id,
  d.status             as deal_status
from matches mt
join      requirements r  on r.id  = mt.requirement_id
left join contacts     c  on c.id  = r.contact_id          -- LEFT: см. выше
left join agents       ca on ca.id = mt.closing_agent_id
left join match_commission_v mc on mc.match_id = mt.id
left join deals        d  on d.match_id = mt.id and d.status <> 'failed';

comment on view object_matches_v is
  'Пункт 4: список подборов на карточке объекта. Контакт через LEFT JOIN — подбор виден даже когда контакт по инварианту 4 закрыт.';

-- ---------------------------------------------------------------------------
-- Подборы на карточке потребности
-- ---------------------------------------------------------------------------

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

  -- Объект и его условия.
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

  -- Мандат: условия договора видны всем агентам.
  m.id                 as mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.listing_agent_id,
  la.full_name         as listing_agent_name,

  -- Собственник: NULL, если инвариант 4 не даёт его этому агенту.
  oo.contact_id        as owner_contact_id,
  oc.name              as owner_name,

  mc.commission_total,
  mc.listing_share,
  mc.closing_share,

  d.id                 as deal_id,
  d.status             as deal_status
from matches mt
join      objects  o  on o.id = mt.object_id
left join mandates m  on m.object_id = mt.object_id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join object_ownerships oo on oo.object_id = mt.object_id and oo.role = 'owner'
left join contacts oc on oc.id = oo.contact_id              -- LEFT: см. выше
left join match_commission_v mc on mc.match_id = mt.id
left join deals    d  on d.match_id = mt.id and d.status <> 'failed';

comment on view requirement_matches_v is
  'Пункт 4: список подборов на карточке потребности. Собственник через LEFT JOIN по той же причине.';

grant select on object_matches_v, requirement_matches_v to authenticated;
revoke all   on object_matches_v, requirement_matches_v from anon;

-- ==== 0009_schedule.sql =========================================

-- 0009_schedule.sql
-- Расписание для app.expire_mandates().
--
-- Это единственное место, где инвариант 1 зависит от чего-то вне базы.
-- Мандат с прошедшим valid_to остаётся в статусе 'active', пока его не
-- погасит expire_mandates(); до тех пор объект висит в каталоге с
-- просроченным договором.
--
-- Почему миграция не падает без pg_cron: на свежем проекте Supabase
-- расширение включается в панели (Database → Extensions), и до этого
-- create extension недоступен. Падение здесь заблокировало бы всю цепочку
-- миграций. Поэтому отсутствие pg_cron — громкое предупреждение, а не ошибка;
-- проверить, что расписание реально стоит, помогает app.schedule_health().

do $$
declare
  v_available boolean;
begin
  select exists (select 1 from pg_available_extensions where name = 'pg_cron')
    into v_available;

  if not v_available then
    raise warning
      'pg_cron недоступен: app.expire_mandates() НЕ запланирована. Инвариант 1 не защищён от истечения мандатов по дате. Включите pg_cron (Supabase: Database → Extensions) и примените эту миграцию снова, либо настройте внешний планировщик.';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Ежедневно в 00:10 UTC — это 06:10 по Бишкеку (UTC+6), то есть до начала
  -- рабочего дня: агенты видят каталог уже без просроченных договоров.
  -- cron.schedule с именем работает как upsert, поэтому повторная миграция
  -- не плодит задания.
  perform cron.schedule(
    'expire-mandates',
    '10 0 * * *',
    $cron$select app.expire_mandates();$cron$
  );

  raise notice 'app.expire_mandates() запланирована ежедневно в 00:10 UTC';
end $$;

-- ---------------------------------------------------------------------------
-- Проверка, что расписание на месте
-- ---------------------------------------------------------------------------
-- Вызывать после развёртывания. Молчаливо незапланированное истечение
-- мандатов — худший из возможных вариантов, поэтому состояние должно быть
-- видно одним запросом.

create or replace function app.schedule_health()
  returns table (check_name text, ok boolean, detail text)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 1. Есть ли pg_cron.
  return query
  select 'pg_cron установлен'::text,
         exists (select 1 from pg_extension where extname = 'pg_cron'),
         coalesce(
           (select 'версия ' || extversion from pg_extension where extname = 'pg_cron'),
           'расширение не установлено: включите его в Supabase → Database → Extensions');

  -- 2. Стоит ли задание.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    return query
    execute $q$
      select 'задание expire-mandates'::text,
             exists (select 1 from cron.job where jobname = 'expire-mandates' and active),
             coalesce((select 'расписание ' || schedule from cron.job
                        where jobname = 'expire-mandates'),
                      'задание не найдено: примените миграцию 0009 заново')
    $q$;
  else
    return query select 'задание expire-mandates'::text, false,
                        'недоступно без pg_cron'::text;
  end if;

  -- 3. Есть ли уже просроченные активные мандаты — симптом того, что
  --    расписание не работает.
  return query
  select 'нет просроченных активных мандатов'::text,
         not exists (select 1 from mandates
                      where status = 'active'
                        and valid_to is not null
                        and valid_to < current_date),
         (select coalesce(
            'просрочено мандатов: ' || count(*)::text ||
            ' — вызовите app.expire_mandates()',
            'все активные мандаты в сроке')
            from mandates
           where status = 'active' and valid_to is not null
             and valid_to < current_date);
end $$;

comment on function app.schedule_health is
  'Состояние расписания инварианта 1. Проверять после каждого развёртывания.';

grant execute on function app.schedule_health() to authenticated;

-- ==== 0010_optional_telegram.sql ================================

-- 0010_optional_telegram.sql
--
-- Вход через Telegram решено не делать, поэтому telegram_id становится
-- необязательным, а якорь ИНВАРИАНТА 6 переезжает на auth_user_id.
--
-- Суть инварианта не меняется: один человек — один аккаунт, повторный вход
-- не создаёт дубликат и не теряет владение объектами. Меняется только то,
-- чем он закреплён — вместо Telegram-идентичности это идентичность
-- Supabase Auth.
--
-- Авторизацию это не задевает вовсе: app.current_agent_id() и app.is_admin()
-- с самого начала опознают агента по agents.auth_user_id = auth.uid(), а не
-- по telegram_id. Инвариант 4, гейт «CRM только одобренным» и все политики
-- RLS работают как работали.
--
-- Вперёд-миграция, а не правка 0001: 0001 мог быть уже применён, и тогда
-- пересборка с нуля и миграция вперёд дали бы разные схемы.

-- ---------------------------------------------------------------------------
-- telegram_id: необязателен, но по-прежнему уникален
-- ---------------------------------------------------------------------------
-- UNIQUE остаётся. В Postgres несколько NULL уникальность не нарушают,
-- поэтому агентов без Telegram может быть сколько угодно, а вот два
-- аккаунта на один и тот же telegram_id — всё так же нельзя.

alter table agents alter column telegram_id drop not null;

-- ---------------------------------------------------------------------------
-- Хотя бы одна идентичность обязательна
-- ---------------------------------------------------------------------------
-- Без этого инвариант 6 получил бы дыру. Строка агента без auth_user_id и
-- без telegram_id ни с каким входом не сопоставляется, но владеть контактами
-- и объектами может. Человек потом логинится, получает НОВУЮ строку, а
-- объекты остаются за мёртвой — ровно та потеря владения, которую
-- инвариант 6 запрещает.

alter table agents add constraint agents_has_identity
  check (auth_user_id is not null or telegram_id is not null);

comment on constraint agents_has_identity on agents is
  'Инвариант 6: у агента обязана быть идентичность, иначе его объекты осиротеют при первом входе.';

comment on column agents.telegram_id is
  'Необязателен (0010). Если задан — уникален: два аккаунта на один Telegram невозможны.';

comment on column agents.auth_user_id is
  'Якорь инварианта 6 (0010). auth.users.id из Supabase Auth. По нему app.current_agent_id() опознаёт агента, и по нему же app.ensure_agent() делает upsert, поэтому повторный вход не плодит дубликат.';

-- ---------------------------------------------------------------------------
-- Вход: upsert по идентичности Supabase Auth
-- ---------------------------------------------------------------------------
-- Авторизационный аналог app.login_by_telegram(): та же защита от дубликата,
-- только по auth.uid(). Вызывается после входа в Supabase Auth — любым
-- способом: почта, OAuth, magic link.
--
-- Новый агент получает status = 'pending' по умолчанию: CRM открывается
-- только после одобрения, и эта функция такого права не даёт.

create or replace function app.ensure_agent(p_full_name text)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  r     agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  insert into agents (auth_user_id, full_name)
  values (v_uid, p_full_name)
  on conflict (auth_user_id) do update
     set full_name  = excluded.full_name,
         updated_at = now()
  returning * into r;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: единственный путь входа без Telegram. Upsert по auth.uid(), поэтому повторный вход возвращает ту же строку и не теряет владение объектами.';

grant execute on function app.ensure_agent(text) to authenticated;

-- ==== 0011_agent_admin.sql ======================================

-- 0011_agent_admin.sql
--
-- Закрывает возможность агента самому себя одобрить и повысить, и даёт
-- админу законные пути одобрения.
--
-- ДЫРА, которую здесь затыкаем. В 0006 политика agents_self_update
-- разрешала правку собственной строки (`auth_user_id = auth.uid()`), а грант
-- был выдан на таблицу целиком: `grant update on agents to authenticated`.
-- Вместе это позволяло любому агенту выполнить
--
--     update agents set status = 'approved', role = 'admin'
--      where auth_user_id = auth.uid();
--
-- и стать админом. Проверено на схеме до этой миграции — проходило.
-- Пока это возможно, экран одобрения агентов не значит ничего.

-- ---------------------------------------------------------------------------
-- Почта агента
-- ---------------------------------------------------------------------------
-- Без неё экран одобрения нечитаем: админ видит заявку, но не понимает, кто
-- её подал. Заполняется из auth.users при входе.

alter table agents add column if not exists email text unique;

comment on column agents.email is
  'Почта из auth.users, заполняется app.ensure_agent(). Нужна экрану одобрения, чтобы заявку можно было опознать.';

-- ---------------------------------------------------------------------------
-- Права: агент правит только своё имя и телефон
-- ---------------------------------------------------------------------------
-- Поколоночный грант вместо табличного. status, role, auth_user_id,
-- telegram_id и email агенту недоступны ни при какой политике.

revoke update on agents from authenticated;
grant update (full_name, phone) on agents to authenticated;

-- ---------------------------------------------------------------------------
-- И то же самое триггером, независимо от грантов
-- ---------------------------------------------------------------------------
-- Гранты можно выдать заново неосторожной миграцией. Триггер держит правило
-- вне зависимости от них — так же, как остальные инварианты.
--
-- Условие `auth.uid() is not null` оставляет прямой доступ к базе
-- (psql, service_role, миграции) рабочим. Это нужно, чтобы завести ПЕРВОГО
-- админа: пока админа нет, одобрить его некому.

create or replace function app.guard_agent_privileges() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if (new.status is distinct from old.status
      or new.role is distinct from old.role)
     and auth.uid() is not null
     and not app.is_admin() then
    raise exception
      'FORBIDDEN: статус и роль агента меняет только админ'
      using errcode = '42501',
            hint = 'Используйте app.approve_agent() / app.block_agent() / app.set_agent_role() от имени админа.';
  end if;
  return new;
end $$;

create trigger b_guard_agent_privileges
  before update of status, role on agents
  for each row execute function app.guard_agent_privileges();

-- ---------------------------------------------------------------------------
-- Законные пути админа
-- ---------------------------------------------------------------------------

-- Последнего админа нельзя ни заблокировать, ни разжаловать: иначе систему
-- можно запереть так, что одобрять новых агентов станет некому.
create or replace function app.assert_admin_remains(p_agent_id uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from agents
     where role = 'admin' and status = 'approved' and id <> p_agent_id
  ) then
    raise exception
      'LAST_ADMIN: это последний админ, одобрять агентов станет некому'
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function app.approve_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: одобрять агентов может только админ'
      using errcode = '42501';
  end if;

  update agents set status = 'approved' where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function app.block_agent(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: блокировать агентов может только админ'
      using errcode = '42501';
  end if;

  -- Если блокируем админа — убедимся, что останется кто-то ещё.
  if exists (select 1 from agents
              where id = p_agent_id and role = 'admin' and status = 'approved') then
    perform app.assert_admin_remains(p_agent_id);
  end if;

  update agents set status = 'blocked' where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function app.set_agent_role(p_agent_id uuid, p_role agent_role)
  returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: роль агента меняет только админ'
      using errcode = '42501';
  end if;

  if p_role <> 'admin' then
    perform app.assert_admin_remains(p_agent_id);
  end if;

  update agents set role = p_role where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Вход: подхватываем почту
-- ---------------------------------------------------------------------------
-- p_full_name стал необязательным: при входе по почте имени ещё нет, и
-- осмысленное значение по умолчанию — сама почта.

create or replace function app.ensure_agent(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
  r       agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');

  insert into agents (auth_user_id, full_name, email)
  values (v_uid, v_name, v_email)
  on conflict (auth_user_id) do update
     -- Пустое имя существующее не затирает.
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         email      = coalesce(excluded.email, agents.email),
         updated_at = now()
  returning * into r;

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Что видит экран одобрения
-- ---------------------------------------------------------------------------
-- Отдельное представление, а не select по agents: только админу и только
-- то, что нужно для решения.

create or replace view admin_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.email, a.phone, a.telegram_id,
  a.role, a.status, a.created_at, a.updated_at,
  -- Чтобы админ видел, что человек уже успел наработать.
  (select count(*) from objects      o where o.created_by_agent_id = a.id) as objects_count,
  (select count(*) from contacts     c where c.owner_agent_id      = a.id) as contacts_count,
  (select count(*) from requirements r where r.agent_id            = a.id) as requirements_count
from agents a
where app.is_admin();

comment on view admin_agents_v is
  'Экран одобрения агентов. where app.is_admin() — не админу представление пусто.';

grant select on admin_agents_v to authenticated;
revoke all   on admin_agents_v from anon;

grant execute on function
  app.approve_agent(uuid), app.block_agent(uuid),
  app.set_agent_role(uuid, agent_role)
  to authenticated;

-- ==== 0012_public_api.sql =======================================

-- 0012_public_api.sql
--
-- Публичные обёртки для функций, которые вызывает кабинет.
--
-- PostgREST выставляет наружу только функции из открытых схем, по умолчанию
-- public. Функции в схеме app через supabase.rpc() недоступны, поэтому
-- ensure_agent, approve_agent и прочее кабинету было не вызвать.
--
-- Обёртки, а не открытие схемы app целиком: открыв app, мы выставили бы
-- наружу и внутренности — app.can_see_contact(), app.write_audit(),
-- app.guard_agent_privileges(). Наружу должно смотреть только то, что
-- кабинету действительно нужно.
--
-- Обёртки намеренно пустые: вся проверка прав осталась внутри app.*,
-- поэтому обойти её, вызвав обёртку, нельзя.

create or replace function ensure_agent(p_full_name text default null)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.ensure_agent(p_full_name)
$$;

create or replace function approve_agent(p_agent_id uuid)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.approve_agent(p_agent_id)
$$;

create or replace function block_agent(p_agent_id uuid)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.block_agent(p_agent_id)
$$;

create or replace function set_agent_role(p_agent_id uuid, p_role agent_role)
  returns agents language sql security definer set search_path = public, pg_temp as $$
  select app.set_agent_role(p_agent_id, p_role)
$$;

create or replace function confirm_actual(p_object_id uuid)
  returns timestamptz language sql security definer set search_path = public, pg_temp as $$
  select app.confirm_actual(p_object_id)
$$;

grant execute on function
  ensure_agent(text), approve_agent(uuid), block_agent(uuid),
  set_agent_role(uuid, agent_role), confirm_actual(uuid)
  to authenticated;

-- ==== 0013_profile.sql ==========================================

-- 0013_profile.sql
--
-- Экран профиля: агент правит своё имя и телефон.
--
-- Упирается в то, что политика agents_read из 0006 требует одобренного
-- агента (`app.current_agent_id() is not null`), поэтому неодобренный не
-- видел даже СВОЮ строку. Следствие было не только про чтение: Postgres
-- применяет SELECT-политику при поиске строк для UPDATE, поэтому
-- `update agents set full_name = ... where auth_user_id = auth.uid()`
-- у неодобренного задевал 0 строк — молча, без ошибки.
--
-- Это мешало и экрану одобрения: админ видел заявку с почтой вместо имени,
-- а человек не мог вписать имя, пока его не одобрят. Замкнутый круг.

-- ---------------------------------------------------------------------------
-- Свою строку агент видит всегда
-- ---------------------------------------------------------------------------
-- Политики складываются по OR, поэтому это только РАСШИРЕНИЕ: одобренные
-- как и раньше видят всех, остальные — ровно себя. О других агентах
-- неодобренный по-прежнему не узнаёт ничего.
--
-- Заблокированному это тоже нужно: иначе кабинет не может объяснить
-- человеку, что доступ отозван, и показывает общий экран ожидания.

create policy agents_read_self on agents for select
  using (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Имя не может быть пустым
-- ---------------------------------------------------------------------------
-- Иначе агент стирает себе имя, и на экране одобрения остаётся пустая
-- строка вместо того, кого нужно опознать.

alter table agents
  add constraint agents_full_name_not_blank check (length(btrim(full_name)) > 0);

-- ---------------------------------------------------------------------------
-- Правка своего профиля
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, и единственная защита — `where auth_user_id = v_uid`:
-- дотянуться до чужой строки функцией нельзя, потому что идентификатор
-- агента она не принимает вовсе.
--
-- Статус и роль в SET не входят. Даже если бы входили, их отбил бы триггер
-- b_guard_agent_privileges из 0011.

create or replace function update_my_profile(
  p_full_name text,
  p_phone     text default null
) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_full_name, ''));
  r      agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;

  if v_name = '' then
    raise exception 'Имя не может быть пустым' using errcode = 'check_violation';
  end if;

  update agents
     set full_name = v_name,
         -- Пустая строка из формы — это «телефона нет», а не пустой телефон.
         phone     = nullif(btrim(coalesce(p_phone, '')), '')
   where auth_user_id = v_uid
  returning * into r;

  if r.id is null then
    raise exception 'агент не найден: сначала войдите' using errcode = 'no_data_found';
  end if;

  return r;
end $$;

comment on function update_my_profile is
  'Правка своего имени и телефона. Чужую строку задеть нельзя: идентификатор агента функция не принимает.';

grant execute on function update_my_profile(text, text) to authenticated;

-- ==== 0014_list_views.sql =======================================

-- 0014_list_views.sql
-- Списки объектов и потребностей в кабинете.
--
-- Представления, а не запросы в коде: инвариант 4 должен держаться и при
-- прямом обращении к PostgREST, а не только через страницу.
--
-- Контакты собираются ПОДЗАПРОСАМИ, а не join-ом. Две причины. Первая:
-- у объекта может быть несколько собственников, и join размножил бы строки
-- объекта. Вторая: подзапрос, которому RLS не отдал ни строки, возвращает
-- NULL, а не выкидывает объект из списка — агент видит объект с пустым
-- собственником, что и требуется по инварианту 4.

-- ---------------------------------------------------------------------------
-- Список объектов
-- ---------------------------------------------------------------------------

create or replace view object_list_v
  with (security_invoker = true) as
select
  o.id,
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
  o.published_at,
  o.actual_at,
  o.created_at,
  o.created_by_agent_id,
  ca.full_name as created_by_name,

  -- Мандат: без активного объект нельзя опубликовать (инвариант 1),
  -- поэтому его состояние в списке видеть важнее всего.
  m.id                 as active_mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.valid_to           as mandate_valid_to,
  la.full_name         as listing_agent_name,

  -- Собственники. NULL, если инвариант 4 их этому агенту не отдаёт.
  (select string_agg(c.name, ', ' order by c.name)
     from object_ownerships oo
     join contacts c on c.id = oo.contact_id
    where oo.object_id = o.id
      and oo.role in ('owner', 'co_owner')) as owners,

  (select count(*) from matches mt where mt.object_id = o.id)      as matches_count,
  (select count(*) from matches mt
    where mt.object_id = o.id and mt.status = 'in_deal')           as deals_count,

  -- Индикативная комиссия. В публичную часть не выносится.
  app.commission_total(o.deal_type, o.price, m.commission_rule)    as commission_total
from objects o
left join mandates m  on m.object_id = o.id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join agents   ca on ca.id = o.created_by_agent_id;

comment on view object_list_v is
  'Список объектов в кабинете. Собственники подзапросом: несколько собственников не размножают объект, а скрытые по инварианту 4 дают NULL вместо исчезновения строки.';

-- ---------------------------------------------------------------------------
-- Список потребностей
-- ---------------------------------------------------------------------------

create or replace view requirement_list_v
  with (security_invoker = true) as
select
  r.id,
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms,
  r.deadline,
  r.requirements_text,
  r.status,
  r.created_at,
  r.updated_at,
  r.agent_id,
  ag.full_name as agent_name,

  -- Клиент. NULL, если инвариант 4 его этому агенту не отдаёт.
  r.contact_id,
  (select c.name from contacts c where c.id = r.contact_id) as client_name,

  (select count(*) from matches mt where mt.requirement_id = r.id)   as matches_count,
  (select count(*) from matches mt
    where mt.requirement_id = r.id
      and mt.status in ('showing_scheduled', 'showing_done'))        as showings_count,
  (select count(*) from matches mt
    where mt.requirement_id = r.id and mt.status = 'in_deal')        as deals_count
from requirements r
left join agents ag on ag.id = r.agent_id;

comment on view requirement_list_v is
  'Список потребностей в кабинете. Клиент подзапросом по той же причине, что собственники в object_list_v.';

grant select on object_list_v, requirement_list_v to authenticated;
revoke all   on object_list_v, requirement_list_v from anon;

-- ==== 0015_write_api.sql ========================================

-- 0015_write_api.sql
-- Создание и правка объектов и потребностей из кабинета.
--
-- Всё одной транзакцией в функции, а не серией вставок из кода. Причина
-- прямая: объект без мандата опубликовать нельзя (инвариант 1), поэтому
-- «создали объект, потом мандат, потом связь с собственником» на любой
-- оборванной середине оставляет объект, с которым нельзя работать.

-- ---------------------------------------------------------------------------
-- Кто может править объект
-- ---------------------------------------------------------------------------
-- В 0006 править объект мог ЛЮБОЙ одобренный агент: политика проверяла
-- только `app.current_agent_id() is not null`. Пока правки делались через
-- SQL, это было терпимо; с появлением формы это значит, что любой агент
-- молча переписывает цены и фото в чужих объектах.
--
-- Сужаю до тех, кто за объект отвечает: кто его завёл, listing-агент
-- активного мандата и админ. РЕШЕНИЕ ОБРАТИМО: если в агентстве принято
-- править объекты сообща, политику можно вернуть к прежнему виду.

drop policy objects_update on objects;

create policy objects_update on objects for update
  using (
    created_by_agent_id = app.current_agent_id()
    or app.is_admin()
    or exists (
      select 1 from mandates m
       where m.object_id = objects.id
         and m.status = 'active'
         and m.listing_agent_id = app.current_agent_id()
    )
  )
  with check (
    created_by_agent_id = app.current_agent_id()
    or app.is_admin()
    or exists (
      select 1 from mandates m
       where m.object_id = objects.id
         and m.status = 'active'
         and m.listing_agent_id = app.current_agent_id()
    )
  );

comment on policy objects_update on objects is
  'Править объект может тот, кто его завёл, listing-агент активного мандата и админ. Остальные агенты объект видят, но не меняют.';

create or replace function app.can_edit_object(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or exists (select 1 from objects o
                  where o.id = p_object_id
                    and o.created_by_agent_id = app.current_agent_id())
      or exists (select 1 from mandates m
                  where m.object_id = p_object_id
                    and m.status = 'active'
                    and m.listing_agent_id = app.current_agent_id())
$$;

grant execute on function app.can_edit_object(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Разбор того, что присылает форма
-- ---------------------------------------------------------------------------

-- Разбор списков из формы: «Центр, Юг» или по строкам.
create or replace function app.strings_from_lines(p_text text) returns text[]
  language sql immutable as $$
  select coalesce(
    array_agg(t.v order by t.v),
    '{}'::text[])
  from (
    select distinct btrim(unnest(string_to_array(
      replace(coalesce(p_text, ''), E'\n', ','), ','))) as v
  ) t
  where t.v <> ''
$$;

create or replace function app.smallints_from_lines(p_text text) returns smallint[]
  language sql immutable as $$
  select coalesce(array_agg(t.v::smallint order by t.v::smallint), '{}'::smallint[])
  from (
    select distinct btrim(unnest(string_to_array(
      replace(coalesce(p_text, ''), E'\n', ','), ','))) as v
  ) t
  where t.v ~ '^[0-9]{1,2}$'
$$;

-- ---------------------------------------------------------------------------
-- Фото: строки в jsonb-массив
-- ---------------------------------------------------------------------------
-- Форма отдаёт ссылки по одной в строке. Загрузки файлов нет — это отдельная
-- работа со Storage; здесь только адреса.

create or replace function app.photos_from_lines(p_lines text) returns jsonb
  language sql immutable as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object('url', t.line))
       from (select btrim(unnest(string_to_array(coalesce(p_lines, ''), E'\n'))) as line) t
      where t.line <> ''),
    '[]'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- Создание объекта
-- ---------------------------------------------------------------------------

create or replace function create_object(
  p_kind                object_kind,
  p_deal_type           deal_type,
  p_address             text,
  p_price               numeric,
  p_zone                text    default null,
  p_rooms               smallint default null,
  p_area                numeric default null,
  p_floor               smallint default null,
  p_floors_total        smallint default null,
  p_currency            text    default 'USD',
  p_description         text    default null,
  p_photos              text    default null,
  -- Собственник: либо ссылка на существующий контакт, либо новый по имени.
  p_owner_contact_id    uuid    default null,
  p_owner_name          text    default null,
  p_owner_phone         text    default null,
  -- Мандат. Задан вид — мандат создаётся, и объект сразу можно публиковать.
  p_mandate_kind        mandate_kind default null,
  p_mandate_valid_to    date    default null,
  p_mandate_start_price numeric default null,
  p_contract_confirmed  boolean default false,
  p_document_url        text    default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_owner_contact_id;
  r         objects;
begin
  insert into objects (
    kind, deal_type, address, zone, rooms, area, floor, floors_total,
    price, currency, description, photos, created_by_agent_id, publication_state
  ) values (
    p_kind, p_deal_type, btrim(p_address), nullif(btrim(coalesce(p_zone, '')), ''),
    p_rooms, p_area, p_floor, p_floors_total,
    p_price, coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'USD'),
    nullif(btrim(coalesce(p_description, '')), ''),
    app.photos_from_lines(p_photos),
    v_agent,
    -- Всегда черновик. Публикация — отдельный шаг, и он требует мандата.
    'draft'
  ) returning * into r;

  -- Собственник. Новый контакт достаётся тому, кто его привёл: на этом
  -- держится инвариант 4.
  if v_contact is null and length(btrim(coalesce(p_owner_name, ''))) > 0 then
    insert into contacts (name, owner_agent_id, roles, source)
    values (btrim(p_owner_name), v_agent,
            case when p_deal_type = 'rent' then '{owner,landlord}'::contact_role[]
                 else '{owner}'::contact_role[] end,
            'заведён с объектом')
    returning id into v_contact;

    if length(btrim(coalesce(p_owner_phone, ''))) > 0 then
      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, btrim(p_owner_phone), true);
    end if;
  end if;

  if v_contact is not null then
    insert into object_ownerships (object_id, contact_id, role, share)
    values (r.id, v_contact, 'owner', 1)
    on conflict do nothing;
  end if;

  -- Мандат.
  if p_mandate_kind is not null then
    insert into mandates (
      object_id, kind, valid_to, start_price, listing_agent_id,
      contract_confirmed, document_url, status
    ) values (
      r.id, p_mandate_kind, p_mandate_valid_to,
      coalesce(p_mandate_start_price, p_price), v_agent,
      coalesce(p_contract_confirmed, false),
      nullif(btrim(coalesce(p_document_url, '')), ''),
      'active'
    );
  end if;

  return r;
end $$;

comment on function create_object is
  'Объект, собственник и мандат одной транзакцией. Объект всегда создаётся черновиком: публикация — отдельный шаг, требующий мандата (инвариант 1).';

-- ---------------------------------------------------------------------------
-- Правка объекта
-- ---------------------------------------------------------------------------
-- Форма показывает все поля и присылает их целиком, поэтому функция их
-- целиком и записывает. actual_at и published_at не трогаем руками:
-- ими распоряжается триггер инварианта 5.

create or replace function update_object(
  p_id           uuid,
  p_kind         object_kind,
  p_deal_type    deal_type,
  p_address      text,
  p_price        numeric,
  p_zone         text    default null,
  p_rooms        smallint default null,
  p_area         numeric default null,
  p_floor        smallint default null,
  p_floors_total smallint default null,
  p_currency     text    default 'USD',
  p_description  text    default null,
  p_photos       text    default null
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r objects;
begin
  perform app.require_agent();

  if not app.can_edit_object(p_id) then
    raise exception 'FORBIDDEN: править объект может тот, кто его завёл, listing-агент активного мандата или админ'
      using errcode = '42501';
  end if;

  update objects set
    kind         = p_kind,
    deal_type    = p_deal_type,
    address      = btrim(p_address),
    zone         = nullif(btrim(coalesce(p_zone, '')), ''),
    rooms        = p_rooms,
    area         = p_area,
    floor        = p_floor,
    floors_total = p_floors_total,
    price        = p_price,
    currency     = coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'USD'),
    description  = nullif(btrim(coalesce(p_description, '')), ''),
    photos       = app.photos_from_lines(p_photos)
  where id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Мандат объекта
-- ---------------------------------------------------------------------------
-- Нужен кабинету: без него созданный объект невозможно опубликовать, и
-- форма создания оставалась бы единственным путём завести договор.

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
  -- Единственность активного мандата держит partial unique index из 0002;
  -- здесь только понятное сообщение вместо ошибки про индекс.
  if app.active_mandate_id(p_object_id) is not null then
    raise exception 'INVARIANT_1: у объекта уже есть активный мандат'
      using errcode = 'check_violation',
            hint = 'Сначала расторгните действующий договор.';
  end if;

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

create or replace function terminate_mandate(p_mandate_id uuid, p_reason text default null)
  returns mandates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r mandates;
begin
  perform app.require_agent();

  if not exists (
    select 1 from mandates m
     where m.id = p_mandate_id
       and (m.listing_agent_id = app.current_agent_id() or app.is_admin())
  ) then
    raise exception 'FORBIDDEN: расторгнуть договор может его listing-агент или админ'
      using errcode = '42501';
  end if;

  -- Триггер d_mandate_release_withdraws_object снимет объект с публикации
  -- и с каналов: без активного мандата он в каталоге быть не может.
  update mandates
     set status = 'terminated',
         closed_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_mandate_id and status = 'active'
  returning * into r;

  if r.id is null then
    raise exception 'активный мандат % не найден', p_mandate_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Создание потребности
-- ---------------------------------------------------------------------------

create or replace function create_requirement(
  p_deal_type        deal_type,
  p_contact_id       uuid    default null,
  p_client_name      text    default null,
  p_client_phone     text    default null,
  p_budget_min       numeric default null,
  p_budget_max       numeric default null,
  p_zones            text    default null,
  p_rooms            text    default null,
  p_deadline         date    default null,
  p_requirements_text text   default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent   uuid := app.require_agent();
  v_contact uuid := p_contact_id;
  r         requirements;
begin
  if v_contact is null and length(btrim(coalesce(p_client_name, ''))) > 0 then
    insert into contacts (name, owner_agent_id, roles, source)
    values (btrim(p_client_name), v_agent,
            case when p_deal_type = 'rent' then '{tenant}'::contact_role[]
                 else '{buyer}'::contact_role[] end,
            'заведён с потребностью')
    returning id into v_contact;

    if length(btrim(coalesce(p_client_phone, ''))) > 0 then
      insert into contact_phones (contact_id, phone, is_primary)
      values (v_contact, btrim(p_client_phone), true);
    end if;
  end if;

  if v_contact is null then
    raise exception 'потребность без клиента невозможна: укажите контакт или имя'
      using errcode = 'check_violation';
  end if;

  insert into requirements (
    contact_id, deal_type, budget_min, budget_max, zones, rooms,
    deadline, requirements_text, agent_id, status
  ) values (
    v_contact, p_deal_type, p_budget_min, p_budget_max,
    app.strings_from_lines(p_zones),
    app.smallints_from_lines(p_rooms),
    p_deadline, nullif(btrim(coalesce(p_requirements_text, '')), ''),
    v_agent, 'new'
  ) returning * into r;

  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Правка потребности
-- ---------------------------------------------------------------------------

create or replace function update_requirement(
  p_id               uuid,
  p_deal_type        deal_type,
  p_budget_min       numeric default null,
  p_budget_max       numeric default null,
  p_zones            text    default null,
  p_rooms            text    default null,
  p_deadline         date    default null,
  p_requirements_text text   default null,
  p_status           requirement_status default null,
  p_closed_reason    text    default null
) returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old requirements%rowtype;
  r     requirements;
begin
  perform app.require_agent();

  select * into v_old from requirements where id = p_id;
  if not found then
    raise exception 'потребность % не найдена', p_id using errcode = 'no_data_found';
  end if;

  if not (v_old.agent_id = app.current_agent_id() or app.is_admin()) then
    raise exception 'FORBIDDEN: править потребность может ведущий её агент или админ'
      using errcode = '42501';
  end if;

  -- Статус «в сделке» руками не ставится: он означает, что по подбору
  -- создана сделка, и приходит из create_deal_from_match (инвариант 2).
  -- Иначе потребность показывала бы сделку, которой нет.
  if p_status = 'in_deal' and v_old.status <> 'in_deal' then
    raise exception 'INVARIANT_2: статус «в сделке» ставится созданием сделки из подбора, а не вручную'
      using errcode = 'check_violation';
  end if;

  update requirements set
    deal_type         = p_deal_type,
    budget_min        = p_budget_min,
    budget_max        = p_budget_max,
    zones             = app.strings_from_lines(p_zones),
    rooms             = app.smallints_from_lines(p_rooms),
    deadline          = p_deadline,
    requirements_text = nullif(btrim(coalesce(p_requirements_text, '')), ''),
    status            = coalesce(p_status, v_old.status),
    closed_reason     = nullif(btrim(coalesce(p_closed_reason, '')), '')
  where id = p_id
  returning * into r;

  return r;
end $$;

grant execute on function
  create_object(object_kind, deal_type, text, numeric, text, smallint, numeric,
                smallint, smallint, text, text, text, uuid, text, text,
                mandate_kind, date, numeric, boolean, text),
  update_object(uuid, object_kind, deal_type, text, numeric, text, smallint,
                numeric, smallint, smallint, text, text, text),
  create_mandate(uuid, mandate_kind, numeric, date, boolean, text, jsonb),
  terminate_mandate(uuid, text),
  create_requirement(deal_type, uuid, text, text, numeric, numeric, text, text, date, text),
  update_requirement(uuid, deal_type, numeric, numeric, text, text, date, text,
                     requirement_status, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Публичная обёртка: право на правку спрашивает страница
-- ---------------------------------------------------------------------------
-- Страница правки не выводит право сама: про listing-агента активного
-- мандата и про админа знает только база.

create or replace function can_edit_object(p_object_id uuid) returns boolean
  language sql security definer set search_path = public, pg_temp as $$
  select app.can_edit_object(p_object_id)
$$;

grant execute on function can_edit_object(uuid) to authenticated;

-- ==== 0016_deal_access.sql ======================================

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

-- ==== 0017_match_status.sql =====================================

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

-- ==== 0018_write_paths.sql ======================================

-- 0018_write_paths.sql
-- Закрытие обходов прямой записью в таблицы.
--
-- Сквозной разбор слоя доступа показал: почти всем таблицам роль
-- authenticated выдана целиком (INSERT/UPDATE/DELETE на все колонки), а
-- политики ограничивают только НАБОР СТРОК, но не набор колонок. Поэтому
-- правило, записанное в функции, обходилось запросом PATCH прямо в таблицу —
-- PostgREST такой путь отдаёт.
--
-- Что было проверено на схеме до этой миграции:
--
--   A. Сторона сделки переписывала суммы комиссии:
--      update deals set closing_share = 99999, listing_share = 1
--      дало «итого 100000, listing 1, closing 99999».
--   B. Автор подбора ставил closing-агентом СЕБЯ:
--      update matches set closing_agent_id = app.current_agent_id()
--      — тот самый захват комиссии, который 0016 закрыл в функции.
--   C. Потребность уходила в 'in_deal' при нуле сделок.
--   D. Агент привязывал СВОЙ контакт собственником к ЧУЖОМУ объекту.
--   E. Любой агент создавал и снимал каналы публикации чужого объекта.
--
-- Общий вывод: где правило про КОЛОНКУ, его держит поколоночный грант или
-- триггер; политика решает только, какие строки видны и правимы.

-- ===========================================================================
-- A. Сделки: пишутся только функциями
-- ===========================================================================
-- У сделки нет законного пути прямой записи: её создаёт
-- create_deal_from_match(), ведёт set_deal_status(), завершают close_deal()
-- и fail_deal(). Все они SECURITY DEFINER, поэтому снятие гранта их не
-- задевает, а клиенту писать в deals больше нечем.

revoke insert, update, delete on deals from authenticated;

-- И отдельно: суммы комиссии неизменяемы, раз уж записаны. Это защита от
-- будущего неосторожного гранта, а не от текущего состояния.
create or replace function app.guard_deal_money() returns trigger
  language plpgsql as $$
begin
  if (old.commission_total is not null and new.commission_total is distinct from old.commission_total)
     or (old.listing_share is not null and new.listing_share is distinct from old.listing_share)
     or (old.closing_share is not null and new.closing_share is distinct from old.closing_share)
     or (old.final_price is not null and new.final_price is distinct from old.final_price) then
    raise exception
      'INVARIANT_3: суммы закрытой сделки неизменяемы — комиссия фиксируется один раз'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_deal_money
  before update on deals
  for each row execute function app.guard_deal_money();

-- ===========================================================================
-- B. Подбор: closing-агент — это агент потребности, и больше ничей
-- ===========================================================================
-- Правило из 0016 было только в create_match(). Теперь это инвариант данных:
-- кто бы и как ни писал в matches, closing_agent_id равен agent_id
-- потребности. Доля closing-агента (инвариант 3) идёт тому, кто ведёт
-- клиента, и присвоить её себе нечем.

create or replace function app.guard_match_closing_agent() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_req_agent uuid;
begin
  select agent_id into v_req_agent from requirements where id = new.requirement_id;

  if new.closing_agent_id is distinct from v_req_agent then
    raise exception
      'INVARIANT_3: closing-агент подбора — это агент потребности (%), присвоить его нельзя',
      v_req_agent
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_match_closing_agent
  before insert or update of closing_agent_id, requirement_id on matches
  for each row execute function app.guard_match_closing_agent();

-- Структурные поля подбора не правятся: подбор — это пара «объект ×
-- потребность», и подменять пару у существующей строки незачем.
revoke update on matches from authenticated;
grant update (status, rejection_reason, showing_at) on matches to authenticated;

-- ===========================================================================
-- C. Потребность: 'in_deal' означает существующую сделку
-- ===========================================================================
-- То же правило, что для подбора в 0017. Было только в update_requirement().

create or replace function app.check_requirement_in_deal() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'in_deal'
     and not exists (select 1 from deals d
                      where d.requirement_id = new.id and d.status <> 'failed') then
    raise exception
      'INVARIANT_2: статус «в сделке» означает существующую сделку — создайте её из подбора'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'in_deal' and new.status <> 'in_deal'
     and exists (select 1 from deals d
                  where d.requirement_id = new.id
                    and d.status not in ('failed', 'closed')) then
    raise exception
      'INVARIANT_2: по потребности идёт сделка — сначала закройте её или отметьте срыв'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create constraint trigger c_requirement_in_deal_requires_deal
  after insert or update of status on requirements
  deferrable initially immediate
  for each row execute function app.check_requirement_in_deal();

-- ===========================================================================
-- D. Собственность: привязать контакт можно только к своему объекту
-- ===========================================================================
-- Прежде политика проверяла лишь, что контакт принадлежит агенту, а объект
-- не проверяла вовсе — поэтому свой контакт привязывался собственником к
-- чужому объекту.

drop policy ownerships_write  on object_ownerships;
drop policy ownerships_update on object_ownerships;
drop policy ownerships_delete on object_ownerships;

create policy ownerships_write on object_ownerships for insert
  with check (
    app.can_edit_object(object_id)
    and exists (select 1 from contacts c
                 where c.id = contact_id
                   and (c.owner_agent_id = app.current_agent_id() or app.is_admin()))
  );

create policy ownerships_update on object_ownerships for update
  using (app.can_edit_object(object_id) and app.can_see_contact(contact_id))
  with check (app.can_edit_object(object_id) and app.can_see_contact(contact_id));

create policy ownerships_delete on object_ownerships for delete
  using (app.can_edit_object(object_id) and app.can_see_contact(contact_id));

comment on policy ownerships_write on object_ownerships is
  'Связь заводится только на объект, за который агент отвечает, и только своим контактом. Иначе чужому объекту можно подставить собственника.';

-- ===========================================================================
-- E. Каналы публикации: только для своих объектов
-- ===========================================================================
-- Прежде политика пускала любого одобренного агента к каналам любого объекта:
-- можно было подделать external_id и снять чужой объект со всех площадок.

drop policy channels_write on publication_channels;

create policy channels_write on publication_channels for all
  using (app.can_edit_object(object_id))
  with check (app.can_edit_object(object_id));

comment on policy channels_write on publication_channels is
  'Выгрузкой распоряжается тот, кто отвечает за объект: снятие с площадок — такое же действие над чужой работой, как снятие с публикации.';

-- ===========================================================================
-- Мандат: структурные поля не переписываются
-- ===========================================================================
-- Мандат привязан к объекту и к listing-агенту. Переподвязать существующий
-- договор к другому объекту или к другому агенту — это не правка, это подлог.

revoke update on mandates from authenticated;
grant update (kind, valid_from, valid_to, start_price, commission_rule,
              contract_confirmed, document_url, document_hash, status, closed_reason)
  on mandates to authenticated;

-- ===========================================================================
-- Объект: published_at и actual_at ведёт триггер инварианта 5
-- ===========================================================================
-- Триггер их и так переписывает обратно, но грант на запись вводит в
-- заблуждение: попытка выглядит успешной, а значение не меняется.

revoke update on objects from authenticated;
grant update (kind, deal_type, address, zone, rooms, area, floor, floors_total,
              price, currency, photos, description, publication_state, actual_at)
  on objects to authenticated;

-- ===========================================================================
-- Потребность и контакт: владение не передаётся правкой колонки
-- ===========================================================================
-- Передача клиента другому агенту — отдельное действие с журналом, а не
-- тихая правка поля. Пока такого действия нет, колонка закрыта.

revoke update on requirements from authenticated;
grant update (deal_type, budget_min, budget_max, zones, rooms, deadline,
              requirements_text, status, closed_reason)
  on requirements to authenticated;

revoke update on contacts from authenticated;
grant update (kind, name, telegram, source, roles, note) on contacts to authenticated;

-- ===========================================================================
-- Подбор: тип сделки должен совпадать
-- ===========================================================================
-- create_match() это проверяет, прямая вставка — нет. Аренду не подбирают
-- под покупку, и такая строка ломает смысл подбора, а не только отчёты.

create or replace function app.guard_match_deal_type() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_obj deal_type; v_req deal_type;
begin
  select deal_type into v_obj from objects      where id = new.object_id;
  select deal_type into v_req from requirements where id = new.requirement_id;

  if v_obj is distinct from v_req then
    raise exception 'подбор невозможен: объект это %, потребность это %', v_obj, v_req
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_match_deal_type
  before insert or update of object_id, requirement_id on matches
  for each row execute function app.guard_match_deal_type();

-- ==== 0019_transfer.sql =========================================

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

-- ==== 0020_activities.sql =======================================

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

-- ==== 0021_contacts.sql =========================================

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

-- ==== 0022_merge_contacts.sql ===================================

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

-- ==== 0023_ownership.sql ========================================

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

-- ==== 0024_reminders.sql ========================================

-- 0024_reminders.sql
-- Напоминания о задачах: очередь в базе.
--
-- Почему очередь, а не отправка «на месте». В этом контейнере нет ни pg_net,
-- ни http — из Postgres исходящий запрос сделать нечем, и на Supabase это
-- тоже отдельное расширение. Поэтому база только РЕШАЕТ, что и кому пора
-- напомнить, а отправляет Next.js по расписанию. Разделение полезно и само
-- по себе: решение о напоминании проверяемо тестами, а отправка — нет.
--
-- Очередь нужна и ради того, чтобы не напомнить дважды. Расписание может
-- сработать повторно, маршрут — упасть на середине; без записи о том, что
-- уже отправлено, агент получит одно и то же несколько раз.

create type notification_kind   as enum ('due_soon', 'overdue');
create type notification_channel as enum ('telegram', 'email');
create type notification_status as enum (
  'pending',    -- ждёт отправки
  'sending',    -- взято в работу: защита от двойной отправки
  'sent',
  'failed',
  'cancelled',  -- задача выполнена или удалена, напоминать незачем
  'no_channel'  -- агенту нечем доставить: Telegram не привязан
);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references agents (id) on delete cascade,
  -- Напоминание живёт ровно столько, сколько задача: удалили задачу —
  -- исчезло и напоминание.
  activity_id uuid not null references activities (id) on delete cascade,
  kind        notification_kind not null,
  channel     notification_channel,
  status      notification_status not null default 'pending',
  body        text not null,
  attempts    smallint not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,

  -- Защита от повторной отправки: одно напоминание каждого вида на задачу.
  -- Именно этот индекс делает app.enqueue_due_reminders() идемпотентной.
  unique (activity_id, kind)
);

comment on table notifications is
  'Очередь напоминаний. unique (activity_id, kind) — единственная защита от того, чтобы напомнить дважды; на неё опирается идемпотентность enqueue.';

create index notifications_pending_idx on notifications (status, created_at)
  where status in ('pending', 'sending');
create index notifications_agent_idx on notifications (agent_id, created_at desc);

alter table notifications enable row level security;

-- Агент видит свои напоминания и больше ничьи: в тексте напоминания стоит
-- текст его задачи.
create policy notifications_read on notifications for select
  using (agent_id = app.current_agent_id() or app.is_admin());

grant select on notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Что считается поводом напомнить
-- ---------------------------------------------------------------------------
-- Задачи и показы со сроком, не выполненные, у действующего агента.
-- Заметки, звонки и сообщения срока не имеют — напоминать о них нечего.
--
-- Два повода, каждый ровно один раз: «скоро» и «просрочено». Их различие
-- несёт смысл: первое можно успеть сделать, второе уже нет.

create or replace function app.enqueue_due_reminders(
  p_horizon interval default interval '24 hours'
) returns table (
  -- Имена с префиксом нарочно: выходной параметр с именем kind сталкивается
  -- со колонкой kind внутри запроса, и Postgres отвечает «ambiguous».
  r_kind     notification_kind,
  r_enqueued integer
)
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with candidates as (
    select
      a.id   as activity_id,
      a.agent_id,
      a.kind as activity_kind,
      a.body,
      a.due_at,
      a.entity_type,
      a.entity_id,
      case when a.due_at < now() then 'overdue'::notification_kind
           else 'due_soon'::notification_kind end as nkind,
      -- Канал: Telegram, если привязан. Почта как канал не реализована,
      -- поэтому агент без Telegram получает запись no_channel, а не тишину.
      case when ag.telegram_id is not null then 'telegram'::notification_channel
           else null end as channel
    from activities a
    join agents ag on ag.id = a.agent_id
   where a.kind in ('task', 'showing')
     and a.due_at is not null
     and not a.done
     -- Заблокированному и неодобренному агенту напоминать не о чем.
     and ag.status = 'approved'
     and a.due_at < now() + p_horizon
  ), titled as (
    select c.*,
      case c.entity_type
        when 'object'      then (select o.address from objects o where o.id = c.entity_id)
        when 'requirement' then (select coalesce(ct.name, 'клиент')
                                   from requirements r
                                   left join contacts ct on ct.id = r.contact_id
                                  where r.id = c.entity_id)
        when 'contact'     then (select ct.name from contacts ct where ct.id = c.entity_id)
        when 'deal'        then (select o.address from deals d
                                   join objects o on o.id = d.object_id
                                  where d.id = c.entity_id)
        when 'match'       then (select o.address from matches m
                                   join objects o on o.id = m.object_id
                                  where m.id = c.entity_id)
        when 'mandate'     then (select o.address from mandates md
                                   join objects o on o.id = md.object_id
                                  where md.id = c.entity_id)
      end as entity_title
    from candidates c
  ), ins as (
    insert into notifications (agent_id, activity_id, kind, channel, status, body)
    select
      t.agent_id, t.activity_id, t.nkind, t.channel,
      case when t.channel is null then 'no_channel'::notification_status
           else 'pending'::notification_status end,
      -- Текст собирается здесь, чтобы отправщик остался простым и не лазил
      -- в данные сам.
      case t.nkind
        when 'overdue'  then 'Просрочено: '
        else 'Скоро срок: '
      end
      || case t.activity_kind when 'showing' then 'показ' else 'задача' end
      || coalesce(' по «' || t.entity_title || '»', '')
      || coalesce(E'\n' || t.body, '')
      || E'\nСрок: ' || to_char(t.due_at at time zone 'Asia/Bishkek', 'DD.MM.YYYY HH24:MI')
    from titled t
    -- Идемпотентность: повторный прогон расписания ничего не добавит.
    on conflict (activity_id, kind) do nothing
    returning notifications.kind
  )
  select i.kind, count(*)::integer from ins i group by i.kind;  -- в r_kind, r_enqueued
end $$;

comment on function app.enqueue_due_reminders is
  'Решает, о чём напомнить. Идемпотентна: повторный прогон не плодит дубликатов благодаря unique (activity_id, kind).';

-- ---------------------------------------------------------------------------
-- Выполнил или удалил — напоминать незачем
-- ---------------------------------------------------------------------------
-- Без этого агент получит напоминание о задаче, которую уже сделал: между
-- постановкой в очередь и отправкой проходит время.

create or replace function app.cancel_reminders_on_done() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.done and not old.done then
    update notifications
       set status = 'cancelled'
     where activity_id = new.id
       and status in ('pending', 'sending');
  end if;

  -- Срок сдвинули — прежние напоминания больше не про него.
  if new.due_at is distinct from old.due_at then
    delete from notifications
     where activity_id = new.id
       and status in ('pending', 'sending', 'no_channel');
  end if;

  return null;
end $$;

create trigger z_cancel_reminders
  after update of done, due_at on activities
  for each row execute function app.cancel_reminders_on_done();

-- ---------------------------------------------------------------------------
-- Отправщик берёт пачку и отчитывается
-- ---------------------------------------------------------------------------
-- Статус 'sending' ставится при выдаче: если расписание сработает дважды
-- одновременно, второй прогон этих строк уже не увидит.
--
-- Доступно только service_role: это работа фонового задания, не агента.

create or replace function app.claim_notifications(p_limit integer default 50)
  returns table (
    id uuid, agent_id uuid, channel notification_channel,
    body text, telegram_id bigint, attempts smallint
  )
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with picked as (
    select n.id from notifications n
     where n.status = 'pending'
       -- Три попытки: дальше молчим, чтобы не долбить мёртвый канал.
       and n.attempts < 3
     order by n.created_at
     limit p_limit
     for update skip locked
  )
  update notifications n
     set status = 'sending', attempts = n.attempts + 1
    from picked p, agents a
   where n.id = p.id and a.id = n.agent_id
  returning n.id, n.agent_id, n.channel, n.body, a.telegram_id, n.attempts;
end $$;

create or replace function app.mark_notification(
  p_id    uuid,
  p_ok    boolean,
  p_error text default null
) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications
     set status = case
                    when p_ok then 'sent'::notification_status
                    -- Исчерпал попытки — больше не берём.
                    when attempts >= 3 then 'failed'::notification_status
                    else 'pending'::notification_status
                  end,
         sent_at = case when p_ok then now() else sent_at end,
         last_error = case when p_ok then null else p_error end
   where id = p_id;
end $$;

grant usage on schema app to service_role;
grant execute on function
  app.enqueue_due_reminders(interval),
  app.claim_notifications(integer),
  app.mark_notification(uuid, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Привязка Telegram
-- ---------------------------------------------------------------------------
-- Агент не может привязать Telegram сам: колонка ему не выдана, а
-- самостоятельная привязка требует подтверждения через бота, которого здесь
-- нет. Пока это делает админ — он и так видит список агентов.

create or replace function set_agent_telegram(
  p_agent_id    uuid,
  p_telegram_id bigint
) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: привязать Telegram может только админ'
      using errcode = '42501';
  end if;

  update agents set telegram_id = p_telegram_id where id = p_agent_id
    returning * into r;

  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

grant execute on function set_agent_telegram(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Что агент видит про свои напоминания
-- ---------------------------------------------------------------------------

create or replace view my_reminders_v
  with (security_invoker = true) as
select
  n.id,
  n.activity_id,
  n.kind,
  n.channel,
  n.status,
  n.body,
  n.attempts,
  n.last_error,
  n.created_at,
  n.sent_at,
  a.due_at,
  a.kind as activity_kind
from notifications n
join activities a on a.id = n.activity_id;

grant select on my_reminders_v to authenticated;
revoke all   on my_reminders_v from anon;

-- ==== 0025_function_grants.sql ==================================

-- 0025_function_grants.sql
--
-- ДЫРА: в Postgres EXECUTE на новую функцию по умолчанию выдан PUBLIC.
-- Поэтому все 52 функции схемы app были вызываемы любым вошедшим агентом,
-- а мои `grant execute ... to service_role` ничего не ограничивали —
-- доступ и так был у всех.
--
-- Проверено на схеме до этой миграции:
--
--   • app.expire_mandates() от имени обычного агента погасила 4 мандата и
--     ОПУСТОШИЛА каталог: опубликованных объектов было 3, стало 0. Любой
--     агент мог снять с публикации всё агентство одним вызовом.
--   • app.backfill_missing_mandates() от имени постороннего создала мандаты
--     по всем объектам без договора. Комиссию это не присвоило — функция
--     берёт listing-агента из created_by объекта, а не из вызывающего, —
--     но массовое создание договоров посторонним всё равно недопустимо.
--   • app.claim_notifications() и app.mark_notification() позволяли агенту
--     выгребать очередь напоминаний и помечать их отправленными.
--
-- Анонима спасало только то, что USAGE на схему app ему не выдан. То есть
-- защита держалась на одном грант-е уровнем выше, а не на самих функциях.
--
-- Лечение: снять дефолтный PUBLIC и выдать явно. Плюс проверка прав внутри
-- двух опасных функций — чтобы правило не зависело только от грантов.

revoke execute on all functions in schema app from public;

-- И на будущее: функции, создаваемые дальше, не получат PUBLIC по умолчанию.
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Что агенту действительно нужно
-- ---------------------------------------------------------------------------
-- Это не произвольный список. Представления объявлены security_invoker, то
-- есть выполняются ОТ ИМЕНИ агента, и функции внутри них он обязан иметь
-- право вызвать. То же касается выражений в политиках RLS. Если забыть
-- что-то здесь, кабинет перестанет читать данные — поэтому список сверен
-- прогоном тестов, а не памятью.

grant execute on function
  -- Опознание и права: используются и в политиках, и в представлениях.
  app.current_agent_id(),
  app.is_admin(),
  app.can_see_contact(uuid),
  app.can_edit_object(uuid),
  app.can_lead_match(uuid),
  app.is_deal_party(uuid),
  app.can_see_entity_activity(text, uuid),
  app.active_mandate_id(uuid),
  -- Комиссия: внутри deal_commission_v, match_commission_v, object_list_v.
  app.commission_total(deal_type, numeric, jsonb),
  app.commission_shares(numeric),
  app.commission_split_ratio(),
  -- Нормализация: внутри contact_duplicates_v и полезна сама по себе.
  app.normalize_phone(text),
  app.normalize_name(text),
  -- Подтверждение актуальности: публичная обёртка вызывает её от владельца,
  -- но агент зовёт и напрямую через app-версию в существующем коде.
  app.confirm_actual(uuid),
  -- Состояние расписания: не секрет, полезно видеть агенту.
  app.schedule_health()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Что нужно фоновому заданию
-- ---------------------------------------------------------------------------

-- Чистая машинная работа: агенту и админу в кабинете она ни к чему.
grant execute on function
  app.enqueue_due_reminders(interval),
  app.claim_notifications(integer),
  app.mark_notification(uuid, boolean, text)
  to service_role;

-- А это админ может захотеть запустить руками, не дожидаясь расписания:
-- app.schedule_health() показывает просроченные мандаты, и логично тут же
-- их погасить. Грант открыт роли authenticated, а не админу — роль в
-- Postgres одна на всех вошедших, — поэтому различает их проверка ВНУТРИ
-- функции. Обычный агент получит отказ, и это проверено тестом.
grant execute on function
  app.expire_mandates(),
  app.backfill_missing_mandates()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- И проверка внутри самих опасных функций
-- ---------------------------------------------------------------------------
-- Грант можно вернуть неосторожной миграцией — как и случилось в харнессе
-- тестов, где `grant execute on all functions in schema app` маскировал
-- настоящие границы. Поэтому правило живёт и внутри функции.
--
-- Условие `auth.uid() is null` оставляет рабочими миграции, psql и
-- service_role: там сессии нет. Это тот же приём, что в триггере прав
-- агента из 0011.

create or replace function app.expire_mandates() returns integer
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_count integer;
begin
  if auth.uid() is not null and not app.is_admin() then
    raise exception
      'FORBIDDEN: истечение мандатов — работа расписания, а не агента'
      using errcode = '42501',
            hint = 'Вызов снимает с публикации все объекты с просроченными договорами.';
  end if;

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

create or replace function app.backfill_missing_mandates()
  returns table (object_id uuid, mandate_id uuid)
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if auth.uid() is not null and not app.is_admin() then
    raise exception
      'FORBIDDEN: перенос объектов — разовая работа админа, а не агента'
      using errcode = '42501';
  end if;

  return query
  insert into mandates (
    object_id, kind, valid_from, valid_to, start_price,
    listing_agent_id, contract_confirmed, status
  )
  select
    o.id, 'non_exclusive',
    coalesce(o.published_at::date, o.created_at::date, current_date),
    null, o.price, o.created_by_agent_id, false, 'active'
  from objects o
  where not exists (select 1 from mandates m where m.object_id = o.id)
  returning mandates.object_id, mandates.id;
end $$;

-- app.expire_mandates() вызывается расписанием из 0009 от имени владельца
-- базы (сессии нет), поэтому проверка её не задевает.

-- ---------------------------------------------------------------------------
-- Публичный каталог не должен зависеть от схемы app
-- ---------------------------------------------------------------------------
-- Снятие дефолтного PUBLIC вскрыло то, что харнесс тестов маскировал:
-- политика objects_read вызывала app.current_agent_id(), а анониму ни USAGE
-- на схему app, ни EXECUTE на эту функцию миграциями не выдавались.
--
-- Проверено: анонимное чтение и public_catalog_v, и objects падало с
-- «permission denied for function current_agent_id». То есть публичный
-- каталог — то единственное, что обязано работать для всех, — в продакшене
-- был сломан, а тесты этого не видели: харнесс выдавал анониму права на
-- схему app, которых в продакшене нет.
--
-- Лечение не грантом, а разделением политики. Условие для анонима теперь
-- не содержит вызова функции вовсе, поэтому каталог не может сломаться
-- из-за прав на схему app. Политики складываются по OR, и роль у каждой
-- своя.

drop policy objects_read on objects;

-- Опубликованное видно всем, включая анонима. Ни одной функции в условии.
create policy objects_read_published on objects for select
  to anon, authenticated
  using (publication_state = 'published');

-- Неопубликованное — только одобренным агентам.
create policy objects_read_agent on objects for select
  to authenticated
  using (app.current_agent_id() is not null);

comment on policy objects_read_published on objects is
  'Публичный каталог. В условии НЕТ вызова функций: иначе каталог зависит от прав анонима на схему app, и это уже один раз его ломало.';

-- ---------------------------------------------------------------------------
-- Публичные обёртки для фонового задания
-- ---------------------------------------------------------------------------
-- PostgREST отдаёт только схему public — для ЛЮБОЙ роли, включая
-- service_role. Поэтому маршрут рассылки не мог вызвать app-функции, и это
-- поймала tests/check-rpc.sh, а не живой прогон.
--
-- Обёртки объявлены SECURITY INVOKER сознательно. SECURITY DEFINER здесь
-- был бы дырой: такая обёртка выполняется от владельца и обошла бы тот
-- самый грант, которым доступ и ограничен. INVOKER плюс грант только
-- service_role — и агенту обёртка недоступна.
--
-- И revoke from public обязателен: EXECUTE на новую функцию по умолчанию
-- выдан PUBLIC, поэтому без него обёртки были бы открыты всем — ровно та
-- ошибка, которую эта миграция и лечит.

create or replace function enqueue_due_reminders(p_horizon interval default interval '24 hours')
  returns table (r_kind notification_kind, r_enqueued integer)
  language sql as $$
  select * from app.enqueue_due_reminders(p_horizon)
$$;

create or replace function claim_notifications(p_limit integer default 50)
  returns table (
    id uuid, agent_id uuid, channel notification_channel,
    body text, telegram_id bigint, attempts smallint
  )
  language sql as $$
  select * from app.claim_notifications(p_limit)
$$;

create or replace function mark_notification(
  p_id uuid, p_ok boolean, p_error text default null
) returns void
  language sql as $$
  select app.mark_notification(p_id, p_ok, p_error)
$$;

revoke execute on function
  enqueue_due_reminders(interval),
  claim_notifications(integer),
  mark_notification(uuid, boolean, text)
  from public;

grant execute on function
  enqueue_due_reminders(interval),
  claim_notifications(integer),
  mark_notification(uuid, boolean, text)
  to service_role;

-- ==== 0026_auth_email_from_jwt.sql ==============================

-- 0026_auth_email_from_jwt.sql
--
-- Вход перестаёт зависеть от чтения auth.users.
--
-- ЧТО НАШЛОСЬ. Проверка на базе, подготовленной как настоящий проект
-- Supabase — схема auth создана не нами, владелец миграций НЕ
-- суперпользователь, — уронила app.ensure_agent():
--
--   ERROR: permission denied for table users
--   CONTEXT: select u.email from auth.users u where u.id = v_uid
--
-- Локально этого не видно: там владелец функции суперпользователь, а он
-- обходит проверки прав. То есть вход держался на привилегии, которой на
-- Supabase у роли миграций может не быть.
--
-- На живом Supabase роль postgres обычно ЧИТАЕТ auth.users, и там вход,
-- скорее всего, работал бы. Но зависимость всё равно лишняя: почта уже
-- есть в самом токене, за ней не нужно ходить в чужую схему.
--
-- Поэтому почта берётся из JWT через auth.jwt(), а чтение auth.users
-- остаётся запасным путём и обёрнуто в перехват исключения: если прав нет,
-- вход не падает, а просто обходится без почты.

create or replace function app.ensure_agent(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
  r       agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  -- Основной путь: почта из токена. Никаких прав на чужие схемы не нужно.
  begin
    v_email := nullif(auth.jwt() ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  -- Запасной путь: таблица пользователей. Нет прав — не беда, вход важнее
  -- почты, и агент впишет имя сам.
  if v_email is null then
    begin
      select u.email into v_email from auth.users u where u.id = v_uid;
    exception when insufficient_privilege or undefined_table then
      v_email := null;
    end;
  end if;

  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');

  insert into agents (auth_user_id, full_name, email)
  values (v_uid, v_name, v_email)
  on conflict (auth_user_id) do update
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         email      = coalesce(excluded.email, agents.email),
         updated_at = now()
  returning * into r;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: вход. Почта берётся из JWT, а не из auth.users: чтение чужой схемы требует прав, которых у роли миграций на Supabase может не быть.';

-- ==== 0027_agent_relink.sql =====================================

-- 0027_agent_relink.sql
-- ИНВАРИАНТ 6: повторный вход не создаёт дубля и не теряет владение объектами.
--
-- Что было найдено на живом проекте. Администратор удаляет человека в
-- Supabase Auth (или тот удаляется по любой другой причине). Строка agents
-- остаётся с auth_user_id, которого больше нет, а вместе с ней остаются её
-- мандаты, потребности и сделки. Человек входит заново по той же почте —
-- Supabase выдаёт новый uid, ensure_agent() пытается вставить вторую строку
-- и падает:
--
--   duplicate key value violates unique constraint "agents_email_key"
--
-- Вход ломался навсегда, а объекты оставались за строкой, в которую уже
-- никто не может войти. Это прямое нарушение инварианта 6.
--
-- Лечим двумя слоями.
--
-- 1. Связь с auth.users объявляется ссылкой с on delete set null. Удаление
--    пользователя само обнуляет auth_user_id, и «сирота» становится видна
--    одним условием `auth_user_id is null` — без чтения схемы auth, прав на
--    которое у роли миграций может не быть (ровно эта зависимость уже
--    ловилась в 0026).
--
-- 2. ensure_agent() подхватывает такую строку по почте: тот же человек
--    возвращается в свою запись со всеми объектами, а не в пустую новую.
--
-- Почему присвоение по почте безопасно: почта взята из токена, то есть её
-- владение только что подтвердил Supabase письмом. И присваиваем мы ТОЛЬКО
-- строку с пустым auth_user_id — чужую живую запись не тронуть даже при
-- совпадении почты.

-- ---------------------------------------------------------------------------
-- 1. Почта — тоже идентичность
-- ---------------------------------------------------------------------------
-- Проверка из 0010 требовала auth_user_id ИЛИ telegram_id. С ней обнулить
-- auth_user_id нельзя, то есть ссылка с on delete set null ниже не смогла бы
-- сработать: удаление пользователя падало бы на проверке.
--
-- Это не обход проверки, а исправление её состава. Смысл проверки — «строка
-- должна быть достижима каким-нибудь входом». Почта как раз и есть тот вход,
-- по которому человек возвращается в свою запись (путь 2 ниже). Строка без
-- всех трёх признаков по-прежнему запрещена: она владела бы объектами, в
-- которые никто не может войти.
--
-- Следствие, о котором стоит знать: если у агента нет ни почты, ни Telegram,
-- удаление его пользователя в Supabase упадёт на этой проверке. Так и нужно —
-- база отказывается осиротить запись, из которой нет пути назад.

alter table agents drop constraint agents_has_identity;
alter table agents add constraint agents_has_identity
  check (auth_user_id is not null or telegram_id is not null or email is not null);

comment on constraint agents_has_identity on agents is
  'Инвариант 6: у строки агента должен быть хотя бы один признак, по которому '
  'вход её найдёт — auth_user_id, telegram_id или почта.';

-- ---------------------------------------------------------------------------
-- 2. Ссылка на auth.users
-- ---------------------------------------------------------------------------
-- Требует права REFERENCES на auth.users. На Supabase миграции идут под
-- postgres, у которого оно есть; это штатный приём самой Supabase. Если
-- права нет, миграция упадёт здесь и громко — это лучше, чем тихо
-- сломанный вход.

alter table agents
  add constraint agents_auth_user_id_fkey
  foreign key (auth_user_id) references auth.users (id) on delete set null;

comment on column agents.auth_user_id is
  'Инвариант 6. on delete set null: удаление пользователя в Supabase Auth '
  'освобождает строку, и ensure_agent() вернёт в неё того же человека по почте.';

-- ---------------------------------------------------------------------------
-- 3. Вход: своя строка → освободившаяся по почте → новая
-- ---------------------------------------------------------------------------

create or replace function app.ensure_agent(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
  r       agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  -- Почта из токена. Никаких прав на чужие схемы не нужно.
  begin
    v_email := nullif(auth.jwt() ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  -- Запасной путь: таблица пользователей. Нет прав — не беда, вход важнее
  -- почты, и агент впишет имя сам.
  if v_email is null then
    begin
      select u.email into v_email from auth.users u where u.id = v_uid;
    exception when insufficient_privilege or undefined_table then
      v_email := null;
    end;
  end if;

  -- Путь 1: своя строка. Обычный повторный вход.
  update agents
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), full_name),
         email      = coalesce(v_email, email),
         updated_at = now()
   where auth_user_id = v_uid
  returning * into r;
  if found then
    return r;
  end if;

  -- Путь 2: строка этого же человека, оставшаяся без пользователя. Забираем
  -- её вместе со всем, что за ней записано.
  if v_email is not null then
    update agents
       set auth_user_id = v_uid,
           full_name    = coalesce(nullif(btrim(p_full_name), ''), full_name),
           updated_at   = now()
     where email = v_email and auth_user_id is null
    returning * into r;
    if found then
      return r;
    end if;
  end if;

  -- Путь 3: новый человек.
  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');
  begin
    insert into agents (auth_user_id, full_name, email)
    values (v_uid, v_name, v_email)
    returning * into r;
  exception when unique_violation then
    -- Почту занимает ЖИВАЯ чужая запись. Сказать это прямо, а не отдавать
    -- наружу текст про нарушение ограничения.
    raise exception 'CONFLICT: почта % уже привязана к другому аккаунту', v_email
      using errcode = '23505';
  end;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: вход. Своя строка → освободившаяся строка с той же почтой → новая. '
  'Почта берётся из JWT, а не из auth.users: чтение чужой схемы требует прав, '
  'которых у роли миграций на Supabase может не быть.';

-- ==== 0028_leads.sql ============================================

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

-- ==== 0029_organizations.sql ====================================

-- 0029_organizations.sql
-- Организация: агентство недвижимости, в котором состоит агент.
--
-- Решение владельца: агент либо работает в агентстве («Этажи» и подобные),
-- либо сам по себе. Принадлежность он заявляет при регистрации.
--
-- Два правила, из которых следует всё остальное.
--
-- 1. Название нормализуется, и оно уникально. Иначе «Этажи», «этажи» и
--    «ЭТАЖИ» станут тремя разными агентствами, фильтр по источнику
--    развалится, а объединять их потом придётся руками. Тот же приём, что
--    у телефонов контактов (0021): ограничение, которое обходится
--    форматированием, хуже отсутствующего.
--
-- 2. Агент ЗАЯВЛЯЕТ агентство, но не подтверждает его. Иначе любой впишет
--    «Этажи» и прикроется чужой репутацией. Поэтому у связи есть отдельный
--    признак org_confirmed, и поднять его может только админ. Снять — может
--    и сам агент, сменив место работы: это не повышение прав.
--
-- Частный агент — это organization_id IS NULL, а не организация с именем
-- «Частный агент». Иначе такие агенты склеятся в одно несуществующее
-- агентство, и «Других организаций» начнёт показывать их вперемешку.

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  name_normalized text generated always as (app.normalize_name(name)) stored,
  -- Кто завёл. NULL — агента удалили, организация осталась.
  created_by_agent_id uuid references agents (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index organizations_name_key on organizations (name_normalized);

comment on table organizations is
  'Агентства недвижимости. Уникальность по нормализованному названию: '
  'иначе «Этажи» и «этажи» станут разными агентствами.';

alter table agents
  add column organization_id uuid references organizations (id) on delete set null,
  -- Подтверждение принадлежности. Поднимает только админ.
  add column org_confirmed boolean not null default false;

comment on column agents.organization_id is
  'Агентство агента. NULL — частный агент, а не организация с таким названием.';
comment on column agents.org_confirmed is
  'Админ подтвердил принадлежность. Агент заявляет сам, подтвердить себя не может.';

create index agents_organization_idx on agents (organization_id) where organization_id is not null;

-- Инвариант 7: организация — такая же сущность.
create trigger zz_audit_organizations after insert or update or delete on organizations
  for each row execute function app.write_audit('organization', 'id');
create trigger a_touch_organizations before update on organizations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------
alter table organizations enable row level security;

-- Список агентств видит любой вошедший агент: без него не выбрать своё
-- место работы и не отфильтровать выдачу по источнику.
create policy organizations_read on organizations for select to authenticated using (true);

grant select on organizations to authenticated;
revoke all on organizations from anon;
revoke insert, update, delete on organizations from authenticated;

-- ---------------------------------------------------------------------------
-- Подтверждение подделать нельзя
-- ---------------------------------------------------------------------------
-- 0011 закрыл самоповышение по status и role поколоночным грантом и
-- триггером. Новые колонки в грант не входят, то есть прямой UPDATE агенту
-- и так недоступен. Но функции ниже идут SECURITY DEFINER, и единственной
-- преградой осталась бы проверка внутри каждой. Поэтому правило переносим в
-- триггер: поднять org_confirmed может только админ, откуда бы вызов ни шёл.

create or replace function app.guard_org_confirmation() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  if new.org_confirmed is distinct from old.org_confirmed
     and new.org_confirmed = true
     and auth.uid() is not null
     and not app.is_admin() then
    raise exception 'FORBIDDEN: подтвердить принадлежность к агентству может только админ'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger b_guard_org_confirmation before update on agents
  for each row execute function app.guard_org_confirmation();

-- ---------------------------------------------------------------------------
-- Агент заявляет своё агентство
-- ---------------------------------------------------------------------------

create or replace function app.set_my_organization(p_name text) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(coalesce(p_name, ''));
  v_me    uuid := app.current_agent_id();
  v_org   uuid;
  r       agents;
begin
  if v_uid is null or v_me is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'BAD_INPUT: название агентства от 2 до 120 символов'
      using errcode = 'check_violation';
  end if;

  -- Ищем по нормализованному названию, заводим только если такого нет.
  select id into v_org from organizations where name_normalized = app.normalize_name(v_name);
  if v_org is null then
    insert into organizations (name, created_by_agent_id) values (v_name, v_me)
    returning id into v_org;
  end if;

  update agents
     set organization_id = v_org,
         -- Смена места работы сбрасывает подтверждение: подтверждали
         -- принадлежность к прежнему агентству, а не к этому.
         org_confirmed = false,
         updated_at = now()
   where id = v_me
  returning * into r;
  return r;
end $$;

comment on function app.set_my_organization is
  'Агент заявляет своё агентство. Подтверждение не выдаётся: его ставит админ.';

create or replace function app.clear_my_organization() returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_me uuid := app.current_agent_id(); r agents;
begin
  if v_me is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;
  update agents set organization_id = null, org_confirmed = false, updated_at = now()
   where id = v_me returning * into r;
  return r;
end $$;

comment on function app.clear_my_organization is
  'Частный агент: связь с агентством снимается. Пустая организация не заводится.';

-- ---------------------------------------------------------------------------
-- Админ: подтверждение и переименование
-- ---------------------------------------------------------------------------

create or replace function app.confirm_agent_organization(p_agent_id uuid, p_confirmed boolean)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: подтверждать принадлежность к агентству может только админ'
      using errcode = '42501';
  end if;
  update agents set org_confirmed = coalesce(p_confirmed, false), updated_at = now()
   where id = p_agent_id returning * into r;
  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  if r.organization_id is null and r.org_confirmed then
    raise exception 'BAD_INPUT: нечего подтверждать — агент не указал агентство'
      using errcode = 'check_violation';
  end if;
  return r;
end $$;

create or replace function app.rename_organization(p_org_id uuid, p_name text)
  returns organizations
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r organizations; v_name text := btrim(coalesce(p_name, ''));
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: переименовать агентство может только админ'
      using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'BAD_INPUT: название агентства от 2 до 120 символов'
      using errcode = 'check_violation';
  end if;
  update organizations set name = v_name where id = p_org_id returning * into r;
  if r.id is null then
    raise exception 'агентство % не найдено', p_org_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Список агентств для выбора и для фильтра по источнику
-- ---------------------------------------------------------------------------

create or replace view organization_list_v
  with (security_invoker = true) as
select o.id,
       o.name,
       count(distinct a.id) filter (where a.status = 'approved') as agents_count,
       count(distinct a.id) filter (where a.status = 'approved' and a.org_confirmed) as confirmed_count
  from organizations o
  left join agents a on a.organization_id = o.id
 group by o.id, o.name
 order by o.name;

comment on view organization_list_v is
  'Агентства со счётчиком агентов — для выбора при регистрации и фильтра по источнику.';

grant select on organization_list_v to authenticated;
revoke all   on organization_list_v from anon;

-- ---------------------------------------------------------------------------
-- Публичные обёртки
-- ---------------------------------------------------------------------------
-- EXECUTE на новой функции схемы public достаётся PUBLIC по умолчанию
-- (0028). Для каждой новой обёртки право снимается и выдаётся явно.

create or replace function set_my_organization(p_name text) returns agents
  language sql as $$ select * from app.set_my_organization(p_name) $$;

create or replace function clear_my_organization() returns agents
  language sql as $$ select * from app.clear_my_organization() $$;

create or replace function confirm_agent_organization(p_agent_id uuid, p_confirmed boolean)
  returns agents
  language sql as $$ select * from app.confirm_agent_organization(p_agent_id, p_confirmed) $$;

create or replace function rename_organization(p_org_id uuid, p_name text) returns organizations
  language sql as $$ select * from app.rename_organization(p_org_id, p_name) $$;

grant execute on function
  app.set_my_organization(text), app.clear_my_organization(),
  app.confirm_agent_organization(uuid, boolean), app.rename_organization(uuid, text)
  to authenticated;

revoke execute on function
  set_my_organization(text), clear_my_organization(),
  confirm_agent_organization(uuid, boolean), rename_organization(uuid, text)
  from public;

grant execute on function
  set_my_organization(text), clear_my_organization(),
  confirm_agent_organization(uuid, boolean), rename_organization(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Экран одобрения: админ видит заявленное агентство
-- ---------------------------------------------------------------------------
-- Без этого подтверждать нечего: админ не увидит, что человек заявил.

-- Пересоздаём, а не заменяем: create or replace не умеет вставлять колонки
-- в середину — он меняет имена существующим и падает.
drop view admin_agents_v;

create view admin_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.email, a.phone, a.telegram_id,
  a.role, a.status, a.created_at, a.updated_at,
  a.organization_id,
  o.name as organization_name,
  a.org_confirmed,
  (select count(*) from objects      ob where ob.created_by_agent_id = a.id) as objects_count,
  (select count(*) from contacts     c  where c.owner_agent_id       = a.id) as contacts_count,
  (select count(*) from requirements r  where r.agent_id             = a.id) as requirements_count
from agents a
left join organizations o on o.id = a.organization_id
where app.is_admin();

comment on view admin_agents_v is
  'Экран одобрения агентов. where app.is_admin() — не админу представление пусто. '
  'Показывает заявленное агентство и признак подтверждения.';

grant select on admin_agents_v to authenticated;
revoke all   on admin_agents_v from anon;

-- ==== 0030_object_source.sql ====================================

-- 0030_object_source.sql
-- Чей это объект: фильтр источника в КАБИНЕТЕ.
--
-- Решение владельца: искать объекты других организаций нужно в CRM, а в
-- публичном каталоге такой возможности быть не должно — каталогом
-- пользуются не только агенты, и внутреннее устройство агентства их не
-- касается. Поэтому ничего из этого не попадает в public_catalog_v: там
-- по-прежнему нет ни агента, ни организации.
--
-- Ответственный за объект — listing-агент активного мандата. Если мандата
-- нет (объект-черновик), отвечает тот, кто его завёл: иначе такие объекты
-- выпадали бы из любого фильтра по источнику.
--
-- Колонки добавляются в КОНЕЦ представления: create or replace умеет
-- дописывать только с конца, вставка в середину роняет миграцию.

create or replace view object_list_v
  with (security_invoker = true) as
select
  o.id,
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
  o.published_at,
  o.actual_at,
  o.created_at,
  o.created_by_agent_id,
  ca.full_name as created_by_name,

  m.id                 as active_mandate_id,
  m.kind               as mandate_kind,
  m.contract_confirmed,
  m.valid_to           as mandate_valid_to,
  la.full_name         as listing_agent_name,

  (select string_agg(c.name, ', ' order by c.name)
     from object_ownerships oo
     join contacts c on c.id = oo.contact_id
    where oo.object_id = o.id
      and oo.role in ('owner', 'co_owner')) as owners,

  (select count(*) from matches mt where mt.object_id = o.id)      as matches_count,
  (select count(*) from matches mt
    where mt.object_id = o.id and mt.status = 'in_deal')           as deals_count,

  app.commission_total(o.deal_type, o.price, m.commission_rule)    as commission_total,

  -- Источник: кто отвечает за объект и в каком он агентстве.
  coalesce(m.listing_agent_id, o.created_by_agent_id)              as responsible_agent_id,
  coalesce(la.full_name, ca.full_name)                             as responsible_name,
  coalesce(la.organization_id, ca.organization_id)                 as responsible_org_id,
  coalesce(lo.name, co.name)                                       as responsible_org_name
from objects o
left join mandates m  on m.object_id = o.id and m.status = 'active'
left join agents   la on la.id = m.listing_agent_id
left join agents   ca on ca.id = o.created_by_agent_id
left join organizations lo on lo.id = la.organization_id
left join organizations co on co.id = ca.organization_id;

comment on view object_list_v is
  'Список объектов в кабинете. Собственники подзапросом: несколько собственников не '
  'размножают объект, а скрытые по инварианту 4 дают NULL вместо исчезновения строки. '
  'responsible_* — источник объекта для фильтра в CRM; в публичную витрину не выносится.';

