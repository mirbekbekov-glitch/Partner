-- 0016_listing_candidates.sql
-- ИНВАРИАНТ 12: кандидат, взятый в работу, закреплён за одним агентом.
-- ИНВАРИАНТ 13: сборщик пишет только в кандидаты.
--
-- Объявления с площадок — сырые данные чужого происхождения. Они не объекты:
-- у них нет мандата, нет собственника в нашей базе, и половина из них —
-- посредники или устаревшие записи. Поэтому они живут отдельной таблицей, и
-- попасть в objects могут только через руки агента, который заключил договор.
--
-- ПРАВОВАЯ СТОРОНА. Сбор чужих объявлений затрагивает условия использования
-- площадок, а телефон из объявления — персональные данные собственника,
-- который согласия нам не давал. Схема это не решает и решить не может: она
-- только сокращает ущерб, если решение окажется неверным. Телефон хранится
-- отдельной таблицей, видят его единицы, удаление кандидата уносит телефон
-- каскадом, а роль сборщика не достаёт ни до чего другого.
--
-- ЧТО ДЕРЖИТ ИНВАРИАНТ 12. «Агенты дерутся за одного и того же клиента» —
-- типовая боль, которую HomeCRM выносит на первый экран. У нас взятие
-- кандидата в работу исключительно: пока агент держит его, второй не может
-- ни перехватить, ни увидеть телефон. Телефон и есть смысл взятия: свободного
-- кандидата видно целиком, кроме номера.

create type listing_source    as enum ('lalafo', 'house_kg', 'manual');
create type listing_author    as enum ('owner', 'agent', 'unknown');
create type candidate_status  as enum ('new', 'in_work', 'taken', 'rejected', 'gone');

create table listing_candidates (
  id             uuid primary key default gen_random_uuid(),

  source         listing_source not null,
  -- Идентификатор объявления на площадке. Вместе с источником даёт ключ,
  -- по которому повторный проход обновляет запись, а не плодит вторую.
  external_id    text not null check (length(btrim(external_id)) > 0),
  url            text,

  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Объявление исчезло с площадки: продано, снято или скрыто.
  gone_at        timestamptz,

  title          text,
  description    text,
  address        text,
  zone           text,
  kind           object_kind,
  deal_type      deal_type,
  rooms          integer,
  area           numeric(10,2),
  floor          integer,
  floors_total   integer,
  price          numeric(14,2),
  currency       text not null default 'USD',
  photos_count   integer not null default 0,

  -- Собственник или посредник. Отделять одно от другого — главная работа
  -- сборщика: объявления агентств нам не нужны.
  author         listing_author not null default 'unknown',

  -- Как пришло с площадки. Хранится, чтобы разбор можно было починить задним
  -- числом, не ходя на площадку снова.
  raw            jsonb,

  status         candidate_status not null default 'new',
  claimed_by_agent_id uuid references agents (id) on delete set null,
  claimed_at     timestamptz,
  -- Взятие не вечно: агент, который взял и не работает, держит кандидата
  -- мёртвым грузом. Освобождает app.release_stale_claims() по расписанию.
  claimed_until  timestamptz,

  object_id      uuid references objects (id) on delete set null,
  rejection_reason text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (source, external_id),

  -- Взятие и статус не расходятся. Без этого правила освобождение, забывшее
  -- снять агента, давало бы «свободного» кандидата, закреплённого за кем-то:
  -- в ленте он показывался бы своим, а взять его мог бы любой.
  constraint candidates_claim_matches_status
    check ((claimed_by_agent_id is not null) = (status in ('in_work', 'taken'))),
  -- Взят в работу — значит известно, до какого срока.
  constraint candidates_in_work_has_deadline
    check (status <> 'in_work' or claimed_until is not null),
  -- Превратился в объект — значит объект указан, и наоборот.
  constraint candidates_taken_has_object
    check ((status = 'taken') = (object_id is not null)),
  constraint candidates_rejection_has_reason
    check (status <> 'rejected'
           or length(btrim(coalesce(rejection_reason, ''))) > 0)
);

comment on table listing_candidates is
  'Инварианты 12 и 13. Сырые объявления с площадок. Не объекты: у них нет мандата и собственника в нашей базе.';
comment on column listing_candidates.raw is
  'Как пришло с площадки. Нужно, чтобы чинить разбор задним числом, не ходя на площадку снова.';
comment on column listing_candidates.claimed_until is
  'Инвариант 12. Срок взятия: взял и не работает — освобождается по расписанию.';

create index candidates_free_idx on listing_candidates (source, last_seen_at desc)
  where status = 'new';
create index candidates_agent_idx on listing_candidates (claimed_by_agent_id, claimed_at desc);
create index candidates_phone_lookup_idx on listing_candidates (status, claimed_until)
  where status = 'in_work';

-- ---------------------------------------------------------------------------
-- Телефон кандидата — отдельной таблицей
-- ---------------------------------------------------------------------------
-- Та же причина, по которой вынесены телефоны контактов: RLS построчный, не
-- поколоночный. Номер в колонке самой записи невозможно закрыть, оставив
-- запись открытой, а именно это и нужно: свободного кандидата видно целиком,
-- кроме номера. Телефон и есть то, ради чего кандидата берут в работу.

create table listing_candidate_phones (
  candidate_id uuid primary key references listing_candidates (id) on delete cascade,
  phone        text not null check (length(btrim(phone)) > 0),
  created_at   timestamptz not null default now()
);

comment on table listing_candidate_phones is
  'Инвариант 12. Номер из объявления. Виден взявшему агенту и админу, остальным — нет.';

-- Номер нормализуется мягко, как у обращений: мусор со стороны площадки не
-- повод терять объявление целиком.
create or replace function app.normalize_candidate_phone() returns trigger
  language plpgsql as $$
declare v text;
begin
  v := app.normalize_phone(new.phone);
  new.phone := coalesce(v, btrim(new.phone));
  return new;
end $$;

create trigger a_candidate_phone
  before insert or update of phone on listing_candidate_phones
  for each row execute function app.normalize_candidate_phone();

-- ---------------------------------------------------------------------------
-- Инвариант 12: взятие исключительно
-- ---------------------------------------------------------------------------

create or replace function app.check_candidate_claim() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Запрещается ПЕРЕДАЧА взятия другому агенту, а не освобождение.
  -- Освобождение (новое значение NULL) — законный путь: так работают
  -- release_candidate, reject_candidate и app.release_stale_claims().
  -- Первая версия этого условия ломала их все, и тест это поймал.
  if tg_op = 'UPDATE'
     and old.status = 'in_work'
     and old.claimed_by_agent_id is not null
     and old.claimed_until > now()
     and new.claimed_by_agent_id is not null
     and new.claimed_by_agent_id is distinct from old.claimed_by_agent_id
     and not app.is_admin() then
    raise exception
      'INVARIANT_12: кандидат уже взят другим агентом до %', old.claimed_until
      using errcode = 'check_violation',
            hint = 'Дождитесь истечения срока или попросите освободить.';
  end if;

  -- Превращение в объект доступно только тому, кто держит кандидата.
  if new.status = 'taken'
     and coalesce(old.status, 'new') <> 'taken'
     and not app.is_admin()
     and old.claimed_by_agent_id is distinct from app.current_agent_id() then
    raise exception
      'INVARIANT_12: превратить кандидата в объект может только взявший его агент'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger b_candidate_claim
  before update on listing_candidates
  for each row execute function app.check_candidate_claim();

-- Один кандидат — один объект. Иначе два агента завели бы два объекта по
-- одному объявлению, и каталог получил бы дубликат с разными мандатами.
create unique index candidates_one_object_idx
  on listing_candidates (object_id) where object_id is not null;

-- ---------------------------------------------------------------------------
-- Журнал (инвариант 7)
-- ---------------------------------------------------------------------------
-- История цены объявления берётся отсюда: отдельной таблицы не нужно.

create trigger a_touch_candidates
  before update on listing_candidates
  for each row execute function app.touch_updated_at();

create trigger zz_audit_candidates
  after insert or update or delete on listing_candidates
  for each row execute function app.write_audit('candidate', 'id');

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------

alter table listing_candidates       enable row level security;
alter table listing_candidate_phones enable row level security;

-- Сам кандидат виден всем агентам: это общий пул, в этом его смысл.
create policy candidates_read on listing_candidates for select
  using (app.current_agent_id() is not null);

-- Править может взявший агент или админ. Сборщик ходит не сюда, а через
-- функцию (инвариант 13).
create policy candidates_update on listing_candidates for update
  using (claimed_by_agent_id = app.current_agent_id()
         or claimed_by_agent_id is null
         or app.is_admin());

create policy candidates_delete on listing_candidates for delete
  using (app.is_admin());

-- Телефон: только взявшему агенту и админу. Это и есть инвариант 12.
create policy candidate_phones_read on listing_candidate_phones for select
  using (
    app.is_admin()
    or exists (
      select 1 from listing_candidates c
       where c.id = listing_candidate_phones.candidate_id
         and c.claimed_by_agent_id = app.current_agent_id()
         and c.status in ('in_work', 'taken')));

create policy candidate_phones_delete on listing_candidate_phones for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- ИНВАРИАНТ 13: роль сборщика
-- ---------------------------------------------------------------------------
-- Сборщик — отдельная роль с ровно одним правом: вызвать функцию приёма.
-- Ни objects, ни contacts, ни mandates ему недоступны, поэтому ошибка в
-- разборе чужой страницы не может превратиться в запись в каталоге.
-- Это не аккуратность кода, а то, до чего роль физически не дотягивается.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'collector') then
    create role collector nologin noinherit;
  end if;
end $$;

grant usage on schema public, app to collector;

-- Приём объявления. Обновляет только данные с площадки и никогда не трогает
-- то, что делает агентство: статус взятия, объект, причину отказа.
create or replace function app.upsert_candidate(p jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_phone text := nullif(btrim(coalesce(p ->> 'phone', '')), '');
begin
  if (p ->> 'source') is null or (p ->> 'external_id') is null then
    raise exception 'INVARIANT_13: обязательны source и external_id'
      using errcode = 'not_null_violation';
  end if;

  insert into listing_candidates (
    source, external_id, url, title, description, address, zone,
    kind, deal_type, rooms, area, floor, floors_total,
    price, currency, photos_count, author, raw, last_seen_at)
  values (
    (p ->> 'source')::listing_source,
    p ->> 'external_id',
    p ->> 'url',
    p ->> 'title',
    p ->> 'description',
    p ->> 'address',
    p ->> 'zone',
    nullif(p ->> 'kind', '')::object_kind,
    nullif(p ->> 'deal_type', '')::deal_type,
    nullif(p ->> 'rooms', '')::integer,
    nullif(p ->> 'area', '')::numeric,
    nullif(p ->> 'floor', '')::integer,
    nullif(p ->> 'floors_total', '')::integer,
    nullif(p ->> 'price', '')::numeric,
    coalesce(nullif(p ->> 'currency', ''), 'USD'),
    coalesce(nullif(p ->> 'photos_count', '')::integer, 0),
    coalesce(nullif(p ->> 'author', '')::listing_author, 'unknown'),
    p -> 'raw',
    now())
  on conflict (source, external_id) do update
     set url          = excluded.url,
         title        = excluded.title,
         description  = excluded.description,
         address      = excluded.address,
         zone         = excluded.zone,
         kind         = excluded.kind,
         deal_type    = excluded.deal_type,
         rooms        = excluded.rooms,
         area         = excluded.area,
         floor        = excluded.floor,
         floors_total = excluded.floors_total,
         price        = excluded.price,
         currency     = excluded.currency,
         photos_count = excluded.photos_count,
         author       = excluded.author,
         raw          = excluded.raw,
         last_seen_at = now(),
         -- Объявление вернулось на площадку: метка исчезновения снимается,
         -- но работа агентства не трогается.
         gone_at      = null,
         status       = case when listing_candidates.status = 'gone'
                             then 'new' else listing_candidates.status end
  returning id into v_id;

  if v_phone is not null then
    insert into listing_candidate_phones (candidate_id, phone)
    values (v_id, v_phone)
    on conflict (candidate_id) do update set phone = excluded.phone;
  end if;

  return v_id;
end $$;

comment on function app.upsert_candidate is
  'Инвариант 13. Единственный путь сборщика в базу. Трогает данные площадки и никогда — работу агентства.';

-- Чего не было в последнем проходе — помечается исчезнувшим, а не удаляется:
-- история нужна, чтобы не брать в работу то, что уже снято.
create or replace function app.mark_candidates_gone(
  p_source  listing_source,
  p_seen    text[],
  p_since   interval default interval '2 days'
) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update listing_candidates
     set status  = 'gone',
         gone_at = now()
   where source = p_source
     and status in ('new', 'gone')
     and last_seen_at < now() - p_since
     and not (external_id = any (coalesce(p_seen, '{}'::text[])))
     and gone_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Истёкшие взятия освобождаются: кандидат возвращается в общий пул.
create or replace function app.release_stale_claims() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update listing_candidates
     set status = 'new', claimed_by_agent_id = null,
         claimed_at = null, claimed_until = null
   where status = 'in_work' and claimed_until < now();
  get diagnostics n = row_count;
  return n;
end $$;

comment on function app.release_stale_claims is
  'Инвариант 12. Освобождает просроченные взятия. Нужен вызов по расписанию, иначе кандидат висит за агентом вечно.';

grant execute on function
  app.upsert_candidate(jsonb),
  app.mark_candidates_gone(listing_source, text[], interval)
  to collector;

-- ---------------------------------------------------------------------------
-- Слой доступа для агента
-- ---------------------------------------------------------------------------

create or replace function claim_candidate(
  p_candidate_id uuid,
  p_days         integer default 3
) returns listing_candidates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  c       listing_candidates%rowtype;
  r       listing_candidates;
begin
  select * into c from listing_candidates where id = p_candidate_id;
  if not found then
    raise exception 'кандидат % не найден', p_candidate_id using errcode = 'no_data_found';
  end if;

  -- Перехват чужого взятия здесь НЕ проверяется: ровно это ловит триггер
  -- b_candidate_claim, и правило должно жить в одном месте. Проверка здесь
  -- была дублем, и мутация это показала — сняв её, тест остался зелёным.
  if c.status in ('taken', 'rejected') then
    raise exception 'кандидат уже закрыт как %', c.status using errcode = 'check_violation';
  end if;

  update listing_candidates
     set status = 'in_work',
         claimed_by_agent_id = v_agent,
         claimed_at = now(),
         claimed_until = now() + make_interval(days => greatest(p_days, 1))
   where id = p_candidate_id
  returning * into r;

  return r;
end $$;

comment on function claim_candidate is
  'Инвариант 12. Взять кандидата в работу. Только после этого виден телефон из объявления.';

create or replace function release_candidate(p_candidate_id uuid)
  returns listing_candidates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       listing_candidates;
begin
  update listing_candidates
     set status = 'new', claimed_by_agent_id = null,
         claimed_at = null, claimed_until = null
   where id = p_candidate_id
     and status = 'in_work'
     and (claimed_by_agent_id = v_agent or app.is_admin())
  returning * into r;

  if r.id is null then
    raise exception 'кандидат % не найден или взят не вами', p_candidate_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function reject_candidate(p_candidate_id uuid, p_reason text)
  returns listing_candidates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r listing_candidates;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'INVARIANT_12: причина отказа обязательна'
      using errcode = 'check_violation';
  end if;

  update listing_candidates
     set status = 'rejected', rejection_reason = p_reason,
         claimed_by_agent_id = null, claimed_at = null, claimed_until = null
   where id = p_candidate_id and status <> 'taken'
  returning * into r;

  if r.id is null then
    raise exception 'кандидат % не найден или уже превращён в объект', p_candidate_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- Превращение в объект. Объект к этому моменту уже создан обычным путём и
-- получил мандат: инвариант 1 никуда не делся, и обойти его отсюда нельзя.
create or replace function convert_candidate(
  p_candidate_id uuid,
  p_object_id    uuid
) returns listing_candidates
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       listing_candidates;
begin
  if app.active_mandate_id(p_object_id) is null then
    raise exception
      'INVARIANT_12: у объекта нет действующего мандата, кандидат не закрывается'
      using errcode = 'check_violation',
            hint = 'Сначала заключите договор с собственником.';
  end if;

  update listing_candidates
     set status = 'taken', object_id = p_object_id
   where id = p_candidate_id
     and status = 'in_work'
     and (claimed_by_agent_id = v_agent or app.is_admin())
  returning * into r;

  if r.id is null then
    raise exception 'кандидат % не взят вами в работу', p_candidate_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function convert_candidate is
  'Инвариант 12. Кандидат закрывается объектом только у взявшего агента и только когда у объекта есть мандат.';

-- ---------------------------------------------------------------------------
-- Данные для кабинета
-- ---------------------------------------------------------------------------
-- Телефон присоединён через LEFT JOIN: агент, которому номер не положен,
-- видит объявление с пустым телефоном, а не теряет строку.

create or replace view candidate_feed_v
  with (security_invoker = true) as
select
  c.id, c.source, c.external_id, c.url,
  c.title, c.address, c.zone, c.kind, c.deal_type,
  c.rooms, c.area, c.floor, c.floors_total,
  c.price, c.currency, c.photos_count, c.author,
  c.status, c.first_seen_at, c.last_seen_at, c.gone_at,
  c.claimed_by_agent_id, c.claimed_until,
  ag.full_name as claimed_by_name,
  c.object_id,
  ph.phone,
  (c.status = 'new')                                     as is_free,
  (c.claimed_by_agent_id = app.current_agent_id())       as is_mine
from listing_candidates c
left join agents ag on ag.id = c.claimed_by_agent_id
left join listing_candidate_phones ph on ph.candidate_id = c.id;

comment on view candidate_feed_v is
  'Пул объявлений. Телефон через LEFT JOIN: инвариант 12 скрывает номер, но не строку.';

-- Отдача источников: сколько собрали, сколько взяли, сколько стало объектами.
create or replace view candidate_funnel_v
  with (security_invoker = true) as
select
  source,
  author,
  count(*)                                        as total,
  count(*) filter (where status = 'new')          as free,
  count(*) filter (where status = 'in_work')      as in_work,
  count(*) filter (where status = 'taken')        as taken,
  count(*) filter (where status = 'rejected')     as rejected,
  count(*) filter (where status = 'gone')         as gone
from listing_candidates
group by source, author;

comment on view candidate_funnel_v is
  'Отдача площадок. Отвечает на вопрос, стоит ли сбор потраченного на него.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, update on listing_candidates to authenticated;
grant select on listing_candidate_phones to authenticated;
grant select on candidate_feed_v, candidate_funnel_v to authenticated;
revoke all on listing_candidates, listing_candidate_phones,
              candidate_feed_v, candidate_funnel_v from anon;

grant execute on function
  claim_candidate(uuid, integer),
  release_candidate(uuid),
  reject_candidate(uuid, text),
  convert_candidate(uuid, uuid),
  app.release_stale_claims()
  to authenticated;
