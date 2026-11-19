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
