-- 0001_schema.sql — схема агентства на Cloudflare D1.
--
-- Перенос с Postgres (Supabase). Что изменилось и почему.
--
-- 1. ПРОВЕРКИ УШЛИ ИЗ БАЗЫ В КОД. В Supabase таблицы торчали наружу через
--    PostgREST, поэтому защита ОБЯЗАНА была жить в базе: проверка в
--    приложении защищала бы только приложение. У D1 наружу не торчит
--    ничего — обратиться к ней может только Worker. Поэтому инварианты
--    живут в lib/db, и обойти их нельзя не потому, что база запрещает, а
--    потому что другого входа в базу нет. Схема держит то, что умеет
--    держать SQLite: ключи, уникальность, CHECK, каскады.
--
-- 2. ENUM стали TEXT + CHECK. В SQLite своих типов нет, но перечень
--    значений держится так же строго.
--
-- 3. ВРЕМЯ — текст ISO-8601 в UTC ('2026-11-25T08:00:00.000Z'). Такие
--    строки сравниваются и сортируются как даты, это свойство формата.
--    Чисел эпохи избегаем намеренно: в журнале аудита их глазами не
--    прочитать.
--
-- 4. ДЕНЬГИ — целые в минорных единицах (центы, тыйыны). Это главное
--    отличие от Postgres, где был numeric(14,2). REAL для денег не годится:
--    0.1 + 0.2 в нём не равно 0.3, а комиссия делится пополам. Целые делятся
--    точно, и остаток виден. Поля с ценой названы *_minor, чтобы никто не
--    записал туда доллары.
--
-- 5. ИДЕНТИФИКАТОРЫ задаёт код (crypto.randomUUID()): gen_random_uuid() в
--    SQLite нет. Колонки остаются TEXT и по-прежнему UUID по содержанию.
--
-- 6. МАССИВЫ И JSONB — текст с JSON, проверяется json_valid(). Разбирает
--    их слой доступа.
--
-- 7. ГЕНЕРИРУЕМЫЕ КОЛОНКИ (phone_normalized, name_normalized) стали
--    обычными: GENERATED в SQLite есть, но позвать из неё normalize_phone()
--    нельзя — своих функций в D1 нет. Нормализацию делает код перед
--    записью, а уникальность по-прежнему держит индекс. Поэтому запись в
--    эти таблицы мимо lib/db запрещена: она обойдёт нормализацию.

pragma foreign_keys = on;

-- ---------------------------------------------------------------------------
-- Агенты
-- ---------------------------------------------------------------------------

create table organizations (
  id                  text primary key,
  name                text not null check (length(trim(name)) between 2 and 120),
  -- Нормализованное имя: «Этажи», «этажи» и «ЭТАЖИ» — одно агентство.
  -- Ограничение, которое обходится форматированием, хуже отсутствующего.
  name_normalized     text not null,
  created_by_agent_id text references agents (id) on delete set null,
  created_at          text not null,
  updated_at          text not null
);

create unique index organizations_name_normalized_idx
  on organizations (name_normalized);

create table agents (
  id            text primary key,
  -- Якорь личности — теперь почта: вход идёт по ссылке на неё.
  -- UNIQUE здесь и есть инвариант 6 на уровне схемы.
  email         text unique,
  -- Telegram остаётся каналом доставки напоминаний, а не входом.
  telegram_id   integer unique,
  full_name     text not null check (length(trim(full_name)) > 0),
  phone         text,
  role          text not null default 'agent'
                     check (role in ('agent', 'admin')),
  status        text not null default 'pending'
                     check (status in ('pending', 'approved', 'blocked')),
  focus         text not null default 'both'
                     check (focus in ('sale', 'rent', 'both')),
  -- Агентство агент ЗАЯВЛЯЕТ сам, а подтверждает только админ: иначе любой
  -- впишет «Этажи» и прикроется чужой репутацией.
  organization_id text references organizations (id) on delete set null,
  org_confirmed   integer not null default 0 check (org_confirmed in (0, 1)),
  created_at    text not null,
  updated_at    text not null,

  -- Безымянный аккаунт — не аккаунт: войти не по чему.
  check (email is not null or telegram_id is not null)
);

create index agents_approved_idx on agents (status) where status = 'approved';

-- ---------------------------------------------------------------------------
-- Вход: одноразовые ссылки и сессии
-- ---------------------------------------------------------------------------
-- Этого в Postgres не было вовсе — вход держала Supabase Auth. Теперь он наш.
--
-- В таблицах лежат только ХЭШИ токенов (SHA-256). Утечка таблицы не даёт
-- войти: по хэшу ссылку не восстановить. Сам токен existует ровно один раз —
-- в письме.

create table login_tokens (
  -- SHA-256 от токена из ссылки, шестнадцатеричной строкой.
  token_hash  text primary key,
  email       text not null,
  created_at  text not null,
  expires_at  text not null,
  -- Отметка о применении: ссылка одноразовая. Повтор — отказ, а не вход.
  used_at     text,
  -- Откуда просили вход. Нужно, чтобы вернуть человека на ту же страницу.
  redirect_to text
);

create index login_tokens_email_idx   on login_tokens (email);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  -- SHA-256 от значения cookie.
  token_hash text primary key,
  agent_id   text not null references agents (id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  -- Последнее обращение: по нему видно брошенные сессии.
  seen_at    text not null
);

create index sessions_agent_idx   on sessions (agent_id);
create index sessions_expires_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Справочник районов
-- ---------------------------------------------------------------------------

create table districts (
  id              text primary key,
  city            text not null default 'Бишкек',
  name            text not null check (length(trim(name)) between 2 and 80),
  name_normalized text not null,
  sort            integer not null default 100,
  active          integer not null default 1 check (active in (0, 1)),
  created_at      text not null
);

create unique index districts_city_name_idx on districts (city, name_normalized);

-- ---------------------------------------------------------------------------
-- Контакты: «один человек — одна запись»
-- ---------------------------------------------------------------------------

create table contacts (
  id             text primary key,
  kind           text not null default 'person'
                      check (kind in ('person', 'company')),
  name           text not null check (length(trim(name)) > 0),
  telegram       text,
  source         text,
  -- Кто привёл контакт. Основа инварианта 4: владелец всегда видит телефон.
  owner_agent_id text not null references agents (id) on delete restrict,
  -- JSON-массив ролей: owner, buyer, tenant, landlord. Роли — флаги ОДНОЙ
  -- записи, а не повод завести вторую; на этом держится правило выше.
  roles          text not null default '[]' check (json_valid(roles)),
  note           text,
  created_at     text not null,
  updated_at     text not null
);

create index contacts_owner_idx on contacts (owner_agent_id);

create table contact_phones (
  id               text primary key,
  contact_id       text not null references contacts (id) on delete cascade,
  phone            text not null check (length(trim(phone)) > 0),
  -- Нормализованный вид. Пустая строка означает «нормализовать нечего»
  -- (иностранный номер из одних цифр), и такие в уникальность не идут.
  phone_normalized text not null,
  is_primary       integer not null default 0 check (is_primary in (0, 1)),
  label            text,
  created_at       text not null,

  unique (contact_id, phone)
);

-- Один номер — один контакт. Это и есть «один человек — одна запись».
create unique index contact_phones_one_contact_per_phone_idx
  on contact_phones (phone_normalized) where phone_normalized <> '';

-- Один основной номер на контакт.
create unique index contact_phones_one_primary_idx
  on contact_phones (contact_id) where is_primary = 1;

create index contact_phones_normalized_idx on contact_phones (phone_normalized);

-- ---------------------------------------------------------------------------
-- Объекты
-- ---------------------------------------------------------------------------

create table objects (
  id                  text primary key,
  kind                text not null check (kind in
                        ('flat', 'room', 'house', 'townhouse', 'land',
                         'commercial', 'garage')),
  deal_type           text not null check (deal_type in ('rent', 'sale')),
  address             text not null check (length(trim(address)) > 0),
  zone                text,
  rooms               integer check (rooms is null or rooms >= 0),
  area                real    check (area  is null or area > 0),
  floor               integer,
  floors_total        integer,
  -- Цена в минорных единицах: 550000 $ это 55000000.
  price_minor         integer not null check (price_minor > 0),
  currency            text not null default 'USD' check (length(currency) = 3),
  -- JSON-массив ссылок на снимки. Файлы лежат в R2.
  photos              text not null default '[]' check (json_valid(photos)),
  description         text,
  source              text,

  -- Публикация это СОСТОЯНИЕ объекта, а не выгрузка во вторую систему.
  publication_state   text not null default 'draft'
                        check (publication_state in
                               ('draft', 'published', 'withdrawn')),

  -- Инвариант 5: ставится один раз при первой публикации и далее неизменно.
  published_at        text,
  -- Инвариант 5: обновляется при правке цены, фото или подтверждении.
  actual_at           text not null,

  created_by_agent_id text not null references agents (id) on delete restrict,
  created_at          text not null,
  updated_at          text not null
);

create index objects_published_idx on objects (publication_state, actual_at)
  where publication_state = 'published';
create index objects_creator_idx   on objects (created_by_agent_id);

create table object_ownerships (
  object_id  text not null references objects  (id) on delete cascade,
  contact_id text not null references contacts (id) on delete restrict,
  role       text not null default 'owner'
                  check (role in ('owner', 'co_owner', 'proxy', 'contact_person')),
  -- Доля. Пустая означает «неизвестна» и в сумму не идёт.
  share      real check (share is null or (share > 0 and share <= 1)),
  created_at text not null,

  primary key (object_id, contact_id, role)
);

create index object_ownerships_contact_idx on object_ownerships (contact_id);

-- ---------------------------------------------------------------------------
-- Мандаты (инвариант 1)
-- ---------------------------------------------------------------------------

create table mandates (
  id                 text primary key,
  object_id          text not null references objects (id) on delete cascade,
  kind               text not null default 'non_exclusive'
                          check (kind in ('exclusive', 'non_exclusive')),
  valid_from         text not null,
  valid_to           text,
  start_price_minor  integer not null check (start_price_minor > 0),
  -- Пусто — работает базовое правило инварианта 3. Переопределение данными,
  -- а не кодом.
  commission_rule    text check (commission_rule is null or json_valid(commission_rule)),
  listing_agent_id   text not null references agents (id) on delete restrict,
  -- Подтверждение договора: ссылка и хэш документа, БЕЗ контактов сторон.
  contract_confirmed integer not null default 0 check (contract_confirmed in (0, 1)),
  document_url       text,
  document_hash      text,
  status             text not null default 'active'
                          check (status in ('active', 'expired',
                                            'terminated', 'closed_by_deal')),
  closed_reason      text,
  created_at         text not null,
  updated_at         text not null,

  check (valid_to is null or valid_to >= valid_from)
);

-- Инвариант 1, половина схемы: не больше одного активного мандата на объект.
create unique index mandates_one_active_per_object_idx
  on mandates (object_id) where status = 'active';

create index mandates_listing_agent_idx on mandates (listing_agent_id);

-- ---------------------------------------------------------------------------
-- Потребности и подборы
-- ---------------------------------------------------------------------------

create table requirements (
  id                text primary key,
  contact_id        text not null references contacts (id) on delete cascade,
  deal_type         text not null check (deal_type in ('rent', 'sale')),
  budget_min_minor  integer check (budget_min_minor is null or budget_min_minor > 0),
  budget_max_minor  integer check (budget_max_minor is null or budget_max_minor > 0),
  -- JSON-массивы.
  zones             text not null default '[]' check (json_valid(zones)),
  rooms             text not null default '[]' check (json_valid(rooms)),
  deadline          text,
  requirements_text text,
  agent_id          text not null references agents (id) on delete restrict,
  status            text not null default 'new'
                         check (status in ('new', 'qualified', 'in_showings',
                                           'in_deal', 'closed', 'lost')),
  closed_reason     text,
  created_at        text not null,
  updated_at        text not null,

  check (budget_min_minor is null or budget_max_minor is null
         or budget_max_minor >= budget_min_minor)
);

create index requirements_agent_idx   on requirements (agent_id);
create index requirements_contact_idx on requirements (contact_id);

create table matches (
  id                  text primary key,
  object_id           text not null references objects      (id) on delete cascade,
  requirement_id      text not null references requirements (id) on delete cascade,
  status              text not null default 'proposed'
                           check (status in ('proposed', 'interested',
                                             'showing_scheduled', 'showing_done',
                                             'bargaining', 'rejected', 'in_deal')),
  rejection_reason    text,
  showing_at          text,
  -- Агент, который ведёт клиента по этому подбору. Источник closing_agent
  -- для комиссии (инвариант 3).
  closing_agent_id    text not null references agents (id) on delete restrict,
  created_by_agent_id text not null references agents (id) on delete restrict,
  created_at          text not null,
  updated_at          text not null,

  unique (object_id, requirement_id),
  -- Отказ обязан иметь причину: иначе аналитика отвала бессмысленна.
  check (status <> 'rejected' or length(trim(coalesce(rejection_reason, ''))) > 0)
);

create index matches_object_idx      on matches (object_id);
create index matches_requirement_idx on matches (requirement_id);

-- ---------------------------------------------------------------------------
-- Сделки (инварианты 2 и 3)
-- ---------------------------------------------------------------------------

create table deals (
  id                    text primary key,
  -- ИНВАРИАНТ 2 на уровне схемы: сделки без подбора не существует.
  match_id              text not null references matches (id) on delete restrict,
  -- Денормализация для истории. Сверяется со связью подбора в слое доступа.
  object_id             text not null references objects      (id) on delete restrict,
  requirement_id        text not null references requirements (id) on delete restrict,
  mandate_id            text not null references mandates     (id) on delete restrict,
  listing_agent_id      text not null references agents (id) on delete restrict,
  closing_agent_id      text not null references agents (id) on delete restrict,
  final_price_minor     integer check (final_price_minor is null or final_price_minor > 0),
  -- Заполняются ПРИ ЗАКРЫТИИ от final_price и дальше не пересчитываются
  -- (инвариант 3). До закрытия суммы индикативны и считаются на лету.
  commission_total_minor integer,
  listing_share_minor    integer,
  closing_share_minor    integer,
  status                text not null default 'deposit'
                             check (status in ('deposit', 'documents', 'signing',
                                               'settlement', 'closed', 'failed')),
  failure_reason        text,
  closed_at             text,
  created_at            text not null,
  updated_at            text not null,

  check (status <> 'failed' or length(trim(coalesce(failure_reason, ''))) > 0),
  check (status <> 'closed' or final_price_minor is not null)
);

create unique index deals_one_per_match_idx on deals (match_id);
create index deals_object_idx on deals (object_id);

-- ---------------------------------------------------------------------------
-- Активности и напоминания
-- ---------------------------------------------------------------------------

create table activities (
  id          text primary key,
  kind        text not null check (kind in ('call', 'showing', 'task', 'note', 'message')),
  entity_type text not null check (entity_type in
                ('contact', 'object', 'mandate', 'requirement', 'match', 'deal')),
  entity_id   text not null,
  agent_id    text not null references agents (id) on delete restrict,
  body        text,
  due_at      text,
  done        integer not null default 0 check (done in (0, 1)),
  done_at     text,
  is_shared   integer not null default 0 check (is_shared in (0, 1)),
  created_at  text not null,
  updated_at  text not null
);

create index activities_entity_idx on activities (entity_type, entity_id);
create index activities_due_idx    on activities (due_at) where done = 0;

create table notifications (
  id          text primary key,
  agent_id    text not null references agents     (id) on delete cascade,
  -- Напоминание живёт ровно столько, сколько задача.
  activity_id text not null references activities (id) on delete cascade,
  kind        text not null check (kind in ('due_soon', 'overdue')),
  channel     text check (channel is null or channel in ('telegram', 'email')),
  status      text not null default 'pending'
                   check (status in ('pending', 'sending', 'sent',
                                     'failed', 'cancelled', 'no_channel')),
  body        text not null,
  attempts    integer not null default 0,
  last_error  text,
  created_at  text not null,
  sent_at     text,

  -- Защита от повторной отправки: одно напоминание каждого вида на задачу.
  -- Именно эта уникальность делает постановку в очередь идемпотентной.
  unique (activity_id, kind)
);

create index notifications_pending_idx on notifications (status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Заявки с сайта
-- ---------------------------------------------------------------------------

create table leads (
  id               text primary key,
  object_id        text not null references objects (id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  phone            text not null,
  phone_normalized text not null,
  message          text check (message is null or length(message) <= 2000),
  status           text not null default 'new'
                        check (status in ('new', 'in_work', 'done', 'spam')),
  agent_id         text references agents     (id) on delete set null,
  activity_id      text references activities (id) on delete set null,
  created_at       text not null,
  updated_at       text not null
);

create index leads_object_idx on leads (object_id, created_at);
create index leads_phone_idx  on leads (phone_normalized, created_at);

create table requests (
  id               text primary key,
  deal             text check (deal is null or deal in ('buy', 'rent')),
  housing_type     text check (housing_type is null or housing_type in
                     ('flat', 'room', 'house', 'townhouse', 'land',
                      'commercial', 'garage')),
  rooms            integer check (rooms is null or (rooms between 1 and 20)),
  district_id      text references districts (id) on delete set null,
  district_other   text check (district_other is null
                     or length(trim(district_other)) between 2 and 120),
  budget_minor     integer check (budget_minor is null or budget_minor > 0),
  budget_currency  text not null default 'USD'
                        check (budget_currency in ('USD', 'KGS')),
  wishes           text check (wishes is null or length(wishes) <= 2000),

  name             text check (name is null or length(trim(name)) between 1 and 120),
  phone            text not null,
  phone_normalized text not null,
  -- Согласие показать контакт агентам даёт ЧЕЛОВЕК, а не агент.
  public_consent   integer not null default 0 check (public_consent in (0, 1)),

  status           text not null default 'new'
                        check (status in ('new', 'in_work', 'closed', 'expired')),
  agent_id         text references agents (id) on delete set null,
  taken_at         text,
  first_response_at text,
  closed_reason    text check (closed_reason is null or closed_reason in
                     ('deal', 'found_self', 'changed_mind', 'no_answer',
                      'spam', 'other')),
  closed_at        text,
  source           text,

  contact_id       text references contacts     (id) on delete set null,
  requirement_id   text references requirements (id) on delete set null,

  created_at       text not null,
  updated_at       text not null,

  -- Взята — значит есть кто и когда.
  check ((status in ('new', 'expired') and agent_id is null and taken_at is null)
      or (status in ('in_work', 'closed') and agent_id is not null and taken_at is not null)),
  -- Закрыта — значит названа причина.
  check ((status = 'closed') = (closed_reason is not null and closed_at is not null))
);

create index requests_status_idx on requests (status, created_at);
create index requests_phone_idx  on requests (phone_normalized, created_at);

-- ---------------------------------------------------------------------------
-- Каналы публикации
-- ---------------------------------------------------------------------------

create table publication_channels (
  id           text primary key,
  object_id    text not null references objects (id) on delete cascade,
  channel      text not null check (channel in ('site', 'mini_app', 'lalafo', 'house_kg')),
  status       text not null default 'exported'
                    check (status in ('exported', 'updated', 'error', 'withdrawn')),
  external_id  text,
  last_sync_at text,
  last_error   text,
  created_at   text not null,
  updated_at   text not null,

  unique (object_id, channel)
);

-- ---------------------------------------------------------------------------
-- Журнал (инвариант 7)
-- ---------------------------------------------------------------------------

create table audit_log (
  id             integer primary key autoincrement,
  entity_type    text not null,
  entity_id      text not null,
  action         text not null check (action in ('insert', 'update', 'delete')),
  -- Пусто означает системное действие: миграция, фоновое задание.
  actor_agent_id text references agents (id) on delete set null,
  -- Что именно изменилось: {"price_minor": {"from": 100, "to": 120}}.
  diff           text not null default '{}' check (json_valid(diff)),
  at             text not null
);

create index audit_log_entity_idx on audit_log (entity_type, entity_id, at);
create index audit_log_actor_idx  on audit_log (actor_agent_id, at);
