-- 0017_candidate_retention.sql
-- ИНВАРИАНТ 14: телефон невзятого кандидата не хранится дольше срока,
--               а кандидат, ставший объектом, не удаляется никогда.
--
-- До этой миграции кандидаты лежали вечно. Для рыночных данных это терпимо,
-- для телефона собственника — нет: мы храним персональные данные человека,
-- который согласия не давал, и «пусть лежит, вдруг пригодится» тут не ответ.
-- Срок хранения должен быть решением, а не умолчанием.
--
-- Два срока, потому что это разные данные:
--
--   телефон — 30 дней с последнего появления объявления на площадке. Если
--             объявление ещё живо, сборщик приносит номер снова, и отсчёт
--             начинается заново. Если объявление сняли — номер уходит;
--   запись  — 180 дней. Без телефона это рыночные данные: цена, площадь,
--             район. Они полезны для аналитики и для того, чтобы не брать
--             в работу то, от чего уже отказались.
--
-- Кандидат, превращённый в объект, не удаляется никогда: он часть истории
-- сделки, и удалить его значило бы потерять, откуда объект взялся.
--
-- ЖУРНАЛ. Инвариант 7 пишет в журнал каждое изменение, и при удалении в diff
-- попадает вся строка — вместе с полем raw, где лежит текст объявления, а в
-- тексте бывает номер. То есть очистка без чистки журнала оставила бы ровно
-- то, что собиралась убрать. Поэтому записи журнала по удалённому кандидату
-- удаляются вместе с ним. Это единственное место, где хранение персональных
-- данных перевешивает полноту журнала, и сделано это сознательно.
--
-- КАК И ИНВАРИАНТ 1, ЭТОТ ЗАВИСИТ ОТ ПЛАНИРОВЩИКА. Без вызова
-- app.purge_candidates() по расписанию сроки не наступают сами. Поэтому рядом
-- стоит представление, которое показывает просрочку: если планировщик молчит,
-- это видно, а не предполагается.

-- ---------------------------------------------------------------------------
-- Номер хранится в одном месте
-- ---------------------------------------------------------------------------
-- Без этого срок хранения телефона был бы неправдой. Площадка отдаёт номер
-- дважды: отдельным полем и внутри текста объявления («звоните 0700…»).
-- Удаление строки из listing_candidate_phones убирало первое и оставляло
-- второе — в description и в raw, а оттуда копия уходила ещё и в журнал.
--
-- Поэтому при приёме объявления номера в свободном тексте затираются. Живёт
-- номер ровно в одной таблице, у которой есть срок и которая удаляется
-- каскадом вместе с кандидатом.

create or replace function app.mask_phones(p_text text) returns text
  language sql immutable as $$
  select case when p_text is null then null else
    -- Заканчивается на цифре, чтобы не съедать пробел после номера.
    regexp_replace(p_text, '(\+?996|\m0)[\s\-()]*\d[\d\s\-()]{5,11}\d',
                   '<номер скрыт>', 'g')
  end
$$;

comment on function app.mask_phones is
  'Инвариант 14. Затирает телефоны в свободном тексте: номер должен храниться только в listing_candidate_phones.';

create or replace function app.mask_phones_json(p jsonb) returns jsonb
  language sql immutable as $$
  select case when p is null then null
              else app.mask_phones(p::text)::jsonb end
$$;

create or replace function app.candidate_phone_ttl_days() returns integer
  language sql immutable as $$ select 30 $$;

create or replace function app.candidate_ttl_days() returns integer
  language sql immutable as $$ select 180 $$;

comment on function app.candidate_phone_ttl_days is
  'Инвариант 14. Сколько дней хранится телефон невзятого кандидата после последнего появления объявления.';
comment on function app.candidate_ttl_days is
  'Инвариант 14. Сколько дней хранится сама запись невзятого кандидата.';

-- Статусы, при которых кандидат считается никому не нужным. in_work не
-- трогаем: над ним работает агент. taken не трогаем никогда.
create or replace function app.candidate_is_idle(p_status candidate_status)
  returns boolean language sql immutable as $$
  select p_status in ('new', 'gone', 'rejected')
$$;

-- ---------------------------------------------------------------------------
-- Очистка
-- ---------------------------------------------------------------------------

create or replace function app.purge_candidates()
  returns table (phones_removed integer, candidates_removed integer)
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phones integer := 0;
  v_rows   integer := 0;
  v_ids    uuid[];
begin
  -- 1. Телефоны тех, кого никто не взял и чьё объявление давно не видели.
  delete from listing_candidate_phones ph
   using listing_candidates c
   where c.id = ph.candidate_id
     and app.candidate_is_idle(c.status)
     and c.last_seen_at < now() - make_interval(days => app.candidate_phone_ttl_days());
  get diagnostics v_phones = row_count;

  -- 2. Сами записи, которым вышел срок.
  select array_agg(id) into v_ids
    from listing_candidates
   where app.candidate_is_idle(status)
     and last_seen_at < now() - make_interval(days => app.candidate_ttl_days());

  if v_ids is not null then
    delete from listing_candidates where id = any (v_ids);
    get diagnostics v_rows = row_count;

    -- Журнал чистится ПОСЛЕ удаления, а не до. Само удаление — тоже событие,
    -- и триггер инварианта 7 дописывает в diff всю строку целиком, вместе с
    -- полем raw, где лежит текст объявления. Чистка до удаления оставила бы
    -- ровно то, что собиралась убрать; первая версия этой функции так и
    -- делала, и тест это поймал.
    delete from audit_log
     where entity_type = 'candidate' and entity_id = any (v_ids);
  end if;

  return query select v_phones, v_rows;
end $$;

comment on function app.purge_candidates is
  'Инвариант 14. Удаляет просроченные телефоны и записи кандидатов вместе с их журналом. Обязателен вызов по расписанию.';

-- ---------------------------------------------------------------------------
-- Видно, когда планировщик молчит
-- ---------------------------------------------------------------------------

create or replace view candidate_retention_v
  with (security_invoker = true) as
select
  app.candidate_phone_ttl_days() as phone_ttl_days,
  app.candidate_ttl_days()       as record_ttl_days,
  (select count(*)
     from listing_candidate_phones ph
     join listing_candidates c on c.id = ph.candidate_id
    where app.candidate_is_idle(c.status)
      and c.last_seen_at < now() - make_interval(days => app.candidate_phone_ttl_days())
  ) as phones_overdue,
  (select count(*)
     from listing_candidates c
    where app.candidate_is_idle(c.status)
      and c.last_seen_at < now() - make_interval(days => app.candidate_ttl_days())
  ) as records_overdue,
  (select min(c.last_seen_at)
     from listing_candidate_phones ph
     join listing_candidates c on c.id = ph.candidate_id
    where app.candidate_is_idle(c.status)
  ) as oldest_phone_seen_at;

comment on view candidate_retention_v is
  'Инвариант 14. Просрочка хранения. Отличное от нуля значение означает, что app.purge_candidates() не вызывается.';

grant select on candidate_retention_v to authenticated;
revoke all on candidate_retention_v from anon;

grant execute on function
  app.purge_candidates(),
  app.candidate_phone_ttl_days(),
  app.candidate_ttl_days(),
  app.candidate_is_idle(candidate_status)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Приём объявления затирает номера в тексте
-- ---------------------------------------------------------------------------
-- app.upsert_candidate переопределяется целиком: меняются две строки, но
-- переписывать функцию по частям нечем.

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
    -- Номер в тексте затирается: храниться он должен в одном месте,
    -- у которого есть срок (инвариант 14).
    app.mask_phones(p ->> 'description'),
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
    app.mask_phones_json(p -> 'raw'),
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

grant execute on function app.upsert_candidate(jsonb) to collector;
grant execute on function app.mask_phones(text), app.mask_phones_json(jsonb) to authenticated;
