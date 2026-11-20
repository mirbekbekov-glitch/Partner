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
