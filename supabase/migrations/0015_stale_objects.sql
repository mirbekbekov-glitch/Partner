-- 0015_stale_objects.sql
-- Отчёт по подвисшим объектам. Это ОТЧЁТ, а не инвариант: новых правил он не
-- вводит и ничего не запрещает. Он показывает то, что уже следует из модели,
-- но до сих пор никому не бросалось в глаза.
--
-- Сигнал о «подвисших» объектах есть у ReCRM и CRM1RS, и это единственное
-- место, где они ближе к нашей модели, чем мы сами: у нас есть actual_at,
-- мандаты со сроком и показы, но ни одного места, где агент увидел бы, что
-- объект забыт.
--
-- Отдельно важен один случай. README честно пишет, что инвариант 1 зависит от
-- внешнего планировщика: без вызова app.expire_mandates() мандат с прошедшим
-- valid_to остаётся активным, и объект висит в каталоге с просроченным
-- договором. Этот отчёт — страховка от того, что планировщик не настроили
-- или он молча перестал работать. Первым же пунктом и с пометкой «срочно».

-- ---------------------------------------------------------------------------
-- Пороги
-- ---------------------------------------------------------------------------
-- Вынесены в функции, чтобы изменение было одной правкой, а не поиском числа
-- по кодовой базе. Та же причина, по которой вынесена доля комиссии.

create or replace function app.stale_after_days() returns integer
  language sql immutable as $$ select 14 $$;

create or replace function app.quiet_after_days() returns integer
  language sql immutable as $$ select 30 $$;

create or replace function app.mandate_warn_days() returns integer
  language sql immutable as $$ select 7 $$;

comment on function app.stale_after_days is
  'Через сколько дней без подтверждения объект считается несвежим (инвариант 5).';
comment on function app.quiet_after_days is
  'Сколько дней объект может висеть в каталоге без единого показа, прежде чем это станет сигналом.';

-- ---------------------------------------------------------------------------
-- Подвисшие объекты
-- ---------------------------------------------------------------------------
-- Рассматриваются объекты с действующим мандатом: это ровно тот круг, за
-- который агентство отвечает перед собственниками. Строка попадает в отчёт,
-- только если нашлась хотя бы одна причина.

create or replace view stale_objects_v
  with (security_invoker = true) as
with base as (
  select
    o.id                as object_id,
    o.address,
    o.zone,
    o.deal_type,
    o.price,
    o.currency,
    o.publication_state,
    o.published_at,
    o.actual_at,
    m.id                as mandate_id,
    m.valid_to,
    m.listing_agent_id,
    ag.full_name        as listing_agent_name,
    (current_date - o.actual_at::date)    as days_since_confirmed,
    case when o.published_at is null then null
         else current_date - o.published_at::date end as days_published,
    (select count(*) from object_photos p where p.object_id = o.id) as photo_count,
    (select count(*) from matches mt where mt.object_id = o.id)     as matches_total,
    (select count(*)
       from showings s join matches mt on mt.id = s.match_id
      where mt.object_id = o.id and s.status = 'done')              as showings_done,
    (select max(s.done_at)
       from showings s join matches mt on mt.id = s.match_id
      where mt.object_id = o.id and s.status = 'done')              as last_showing_at,
    (select count(*) from publication_channels pc
      where pc.object_id = o.id and pc.last_error is not null)      as channel_errors
  from objects o
  join mandates m on m.object_id = o.id and m.status = 'active'
  left join agents ag on ag.id = m.listing_agent_id
),
flagged as (
  select
    b.*,
    -- Срок договора вышел, а объект всё ещё в каталоге. Значит
    -- app.expire_mandates() не отработала: единственная точка, где инвариант 1
    -- зависит от внешнего планировщика.
    (b.valid_to is not null and b.valid_to < current_date)          as mandate_expired,
    (b.valid_to is not null and b.valid_to >= current_date
     and b.valid_to <= current_date + app.mandate_warn_days())      as mandate_expiring,
    (b.publication_state = 'published'
     and b.days_since_confirmed > app.stale_after_days())           as needs_confirmation,
    (b.publication_state = 'published' and b.photo_count = 0)       as no_photos,
    (b.publication_state = 'published'
     and b.days_published > app.quiet_after_days()
     and b.showings_done = 0)                                       as no_showings,
    (b.channel_errors > 0)                                          as channel_error,
    -- Мандат есть, а объекта в каталоге нет. Договор работает, объект — нет.
    (b.publication_state <> 'published')                            as not_published
  from base b
)
select
  f.object_id, f.address, f.zone, f.deal_type, f.price, f.currency,
  f.publication_state, f.published_at, f.actual_at,
  f.mandate_id, f.valid_to, f.listing_agent_id, f.listing_agent_name,
  f.days_since_confirmed, f.days_published,
  f.photo_count, f.matches_total, f.showings_done, f.last_showing_at,
  f.channel_errors,
  f.mandate_expired, f.mandate_expiring, f.needs_confirmation,
  f.no_photos, f.no_showings, f.channel_error, f.not_published,
  array_remove(array[
    case when f.mandate_expired    then 'срок договора вышел' end,
    case when f.not_published      then 'мандат есть, объекта в каталоге нет' end,
    case when f.needs_confirmation then 'давно не подтверждали' end,
    case when f.channel_error      then 'ошибка размещения на площадке' end,
    case when f.no_photos          then 'нет фотографий' end,
    case when f.no_showings        then 'в каталоге давно, показов нет' end,
    case when f.mandate_expiring   then 'договор скоро кончится' end
  ], null) as reasons,
  case
    when f.mandate_expired then 'critical'
    when f.needs_confirmation
     and f.days_since_confirmed > app.stale_after_days() * 2 then 'critical'
    else 'warning'
  end as severity
from flagged f
where f.mandate_expired or f.mandate_expiring or f.needs_confirmation
   or f.no_photos or f.no_showings or f.channel_error or f.not_published;

comment on view stale_objects_v is
  'Отчёт, а не инвариант. Объекты с действующим мандатом, по которым что-то не так. Просроченный мандат идёт первым: это страховка от неработающего планировщика.';

-- ---------------------------------------------------------------------------
-- Свод по агентам
-- ---------------------------------------------------------------------------
-- Руководителю нужен не список из трёхсот строк, а ответ на вопрос, у кого
-- горит.

create or replace view stale_summary_v
  with (security_invoker = true) as
select
  listing_agent_id,
  listing_agent_name,
  count(*)                                        as total,
  count(*) filter (where severity = 'critical')   as critical,
  count(*) filter (where mandate_expired)         as mandate_expired,
  count(*) filter (where needs_confirmation)      as needs_confirmation,
  count(*) filter (where no_photos)               as no_photos,
  count(*) filter (where no_showings)             as no_showings,
  count(*) filter (where not_published)           as not_published
from stale_objects_v
group by listing_agent_id, listing_agent_name;

comment on view stale_summary_v is
  'Свод подвисших объектов по listing-агентам. Для руководителя.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
-- Видно всем агентам, как и условия мандатов: объект чужим не становится
-- оттого, что по нему что-то забыли. Анониму не видно ничего.

grant select on stale_objects_v, stale_summary_v to authenticated;
revoke all on stale_objects_v, stale_summary_v from anon;

grant execute on function
  app.stale_after_days(), app.quiet_after_days(), app.mandate_warn_days()
  to authenticated;
