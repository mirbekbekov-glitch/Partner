-- 0019_scheduler.sql
-- ИНВАРИАНТ 16: каждая обязательная работа по расписанию оставляет запись о
--               каждом запуске — удачном и неудачном; журнал запусков не
--               переписывается; работа, молчащая дольше своего срока, видна
--               как задержка, а не как тишина.
--
-- Три функции обязаны вызываться по расписанию, иначе инварианты держатся
-- только на словах:
--
--   app.expire_mandates()      — без неё мандат с прошедшим valid_to остаётся
--                                активным, и объект висит в каталоге с
--                                просроченным договором (инвариант 1);
--   app.release_stale_claims() — без неё кандидат остаётся закреплённым за
--                                агентом после срока, и никто другой его не
--                                возьмёт (инвариант 12);
--   app.purge_candidates()     — без неё телефон собственника лежит дольше
--                                объявленного срока хранения (инвариант 14).
--
-- ГЛАВНАЯ ОПАСНОСТЬ ПЛАНИРОВЩИКА — НЕ ОШИБКА, А ТИШИНА. Упавшая задача
-- заметна: есть сообщение, есть стек. Не запущенная задача не даёт ничего:
-- система выглядит работающей, мандаты просто не истекают, телефоны просто
-- лежат. Поэтому расписание здесь это не одна строка в cron, а три вещи:
--
--   1. список работ со сроком молчания — данные, которые видно и можно менять;
--   2. журнал запусков, который нельзя переписать;
--   3. представление, которое говорит «задержка», когда записи нет.
--
-- САМО РАСПИСАНИЕ ВЕДЁТ pg_cron, и миграция его НЕ включает. Включение
-- pg_cron — действие уровня кластера (shared_preload_libraries и
-- cron.database_name), а не схемы, и в тестовых базах расширения нет вовсе.
-- Поэтому регистрация расписания вынесена в app.install_schedule(): её
-- вызывают один раз руками после развёртывания, и она внятно сообщает, чего
-- не хватает. Миграции при этом остаются переносимыми.

-- ---------------------------------------------------------------------------
-- Список работ
-- ---------------------------------------------------------------------------
-- Расписание и срок молчания — данные: их настраивает тот, кто ведёт систему.
-- Сама работа — код: добавление новой задачи это новая функция, то есть новая
-- миграция, а не строка в таблице. Поэтому имена работ перечислены в
-- app.run_maintenance() явным case, и подстановка имени в SQL нигде не
-- происходит.

create table maintenance_jobs (
  -- uuid, как у всех сущностей схемы: журнал инварианта 7 хранит entity_id
  -- одним типом, и работа со строковым ключом в него не поместилась бы.
  -- Имя работы при этом остаётся ключом по смыслу — оно уникально и на него
  -- ссылается журнал запусков.
  id              uuid        primary key default gen_random_uuid(),
  job             text        not null unique,
  description     text        not null,
  -- Выражение cron в пяти полях. Минуты нарочно не нулевые: все расписания
  -- мира стоят на ровном часе, и очередь на :00 ждать незачем.
  cron_expression text        not null,
  -- Сколько работа может молчать, прежде чем это считается поломкой. С
  -- запасом к расписанию: одна пропущенная минута не повод для тревоги,
  -- сутки тишины у суточной задачи — повод.
  max_silence     interval    not null check (max_silence > interval '0'),
  enabled         boolean     not null default true,
  created_at      timestamptz not null default now()
);

comment on table maintenance_jobs is
  'Инвариант 16. Работы, обязательные по расписанию: что запускать, как часто и сколько молчания считать поломкой.';

insert into maintenance_jobs (job, description, cron_expression, max_silence) values
  ('expire_mandates',
   'Истечение мандатов по дате: снимает с публикации объекты с просроченным договором (инвариант 1)',
   '7 3 * * *',  interval '36 hours'),
  ('release_stale_claims',
   'Освобождение просроченных взятий кандидатов: возвращает в пул то, за что агент не взялся (инвариант 12)',
   '17 * * * *', interval '3 hours'),
  ('purge_candidates',
   'Срок хранения кандидатов: удаляет просроченные телефоны и записи вместе с журналом (инвариант 14)',
   '41 4 * * *', interval '36 hours');

-- ---------------------------------------------------------------------------
-- Журнал запусков
-- ---------------------------------------------------------------------------

create table maintenance_runs (
  id          bigserial   primary key,
  job         text        not null references maintenance_jobs (job),
  started_at  timestamptz not null,
  finished_at timestamptz not null,
  ok          boolean     not null,
  -- Что именно сделано: сколько мандатов истекло, сколько телефонов удалено.
  -- Без этого «запустилось» и «сработало» неотличимы.
  result      jsonb,
  error       text,
  constraint runs_error_matches_ok check ((error is null) = ok),
  constraint runs_finished_after_start check (finished_at >= started_at)
);

create index maintenance_runs_job_idx on maintenance_runs (job, started_at desc);

comment on table maintenance_runs is
  'Инвариант 16. Журнал запусков плановых работ. Только добавление: запись о падении не переписывается.';

-- Журнал только дописывается. Иначе запись о падении можно поправить, и
-- тогда он перестаёт быть доказательством чего-либо. Строк немного: три
-- работы дают около 26 тысяч записей в год, поэтому срока хранения здесь
-- нет — персональных данных в журнале тоже нет.
create or replace function app.maintenance_runs_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'INVARIANT_16: журнал запусков только дописывается (попытка %)', lower(tg_op)
    using errcode = 'raise_exception';
end $$;

create trigger z_maintenance_runs_append_only
  before update or delete on maintenance_runs
  for each row execute function app.maintenance_runs_append_only();

-- ---------------------------------------------------------------------------
-- Запуск
-- ---------------------------------------------------------------------------
-- Запись пишется в конце, а не в начале. В одной транзакции строка «начал»
-- откатилась бы вместе с упавшей работой, а отдельной транзакцией плановая
-- задача не распоряжается. Если работу убили на полпути (перезапуск сервера),
-- записи не будет вовсе — и это увидит представление ниже как задержку.

create or replace function app.run_maintenance(p_job text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_started timestamptz := clock_timestamp();
  v_result  jsonb;
  v_error   text;
  v_enabled boolean;
begin
  select enabled into v_enabled from maintenance_jobs where job = p_job;
  if v_enabled is null then
    raise exception 'INVARIANT_16: работа % не объявлена в maintenance_jobs', p_job
      using errcode = 'invalid_parameter_value';
  end if;
  if not v_enabled then
    raise exception 'INVARIANT_16: работа % выключена', p_job
      using errcode = 'invalid_parameter_value';
  end if;

  -- Каждая работа в своём блоке: падение одной не должно уносить остальные
  -- и не должно мешать записать, что она упала.
  begin
    case p_job
      when 'expire_mandates' then
        v_result := jsonb_build_object('mandates_expired', app.expire_mandates());
      when 'release_stale_claims' then
        v_result := jsonb_build_object('claims_released', app.release_stale_claims());
      when 'purge_candidates' then
        v_result := (select jsonb_build_object('phones_removed', phones_removed,
                                               'candidates_removed', candidates_removed)
                       from app.purge_candidates());
      else
        -- Работа есть в таблице, а кода для неё нет. Это ошибка миграции,
        -- и молчать о ней нельзя.
        raise exception 'INVARIANT_16: для работы % нет кода', p_job
          using errcode = 'invalid_parameter_value';
    end case;
  exception when others then
    v_error := SQLERRM;
  end;

  insert into maintenance_runs (job, started_at, finished_at, ok, result, error)
  values (p_job, v_started, clock_timestamp(), v_error is null, v_result, v_error);

  return jsonb_build_object('job', p_job, 'ok', v_error is null,
                            'result', v_result, 'error', v_error);
end $$;

comment on function app.run_maintenance is
  'Инвариант 16. Выполняет одну плановую работу и записывает результат в журнал. Не падает от падения работы.';

create or replace function app.run_maintenance_all()
  returns table (job text, ok boolean, result jsonb, error text)
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v jsonb;
begin
  for r in select mj.job from maintenance_jobs mj where mj.enabled order by mj.job loop
    v := app.run_maintenance(r.job);
    return query select r.job, (v ->> 'ok')::boolean, v -> 'result', v ->> 'error';
  end loop;
end $$;

comment on function app.run_maintenance_all is
  'Инвариант 16. Выполняет все включённые плановые работы. Точка входа для внешнего cron, если pg_cron недоступен.';

-- ---------------------------------------------------------------------------
-- Видно, когда планировщик молчит
-- ---------------------------------------------------------------------------

create or replace view maintenance_health_v
  with (security_invoker = true) as
select
  j.job,
  j.description,
  j.cron_expression,
  j.max_silence,
  j.enabled,
  r.last_run_at,
  r.last_ok_at,
  r.last_error,
  now() - r.last_ok_at as silence,
  case
    when not j.enabled              then 'выключена'
    when r.last_run_at is null      then 'ни разу не запускалась'
    when r.last_ok_at  is null      then 'падает с первого запуска'
    when now() - r.last_ok_at > j.max_silence
         and r.last_error is not null then 'падает'
    when now() - r.last_ok_at > j.max_silence then 'задержка'
    else 'в норме'
  end as status
from maintenance_jobs j
left join lateral (
  select max(mr.started_at)                                  as last_run_at,
         max(mr.started_at) filter (where mr.ok)             as last_ok_at,
         (select mr2.error from maintenance_runs mr2
           where mr2.job = j.job order by mr2.started_at desc limit 1) as last_error
    from maintenance_runs mr
   where mr.job = j.job
) r on true;

comment on view maintenance_health_v is
  'Инвариант 16. Состояние планировщика. Всё, кроме «в норме» и «выключена», означает, что работа не идёт.';

-- Одно число для проверки одной строкой: сколько включённых работ не в норме.
create or replace function app.maintenance_overdue() returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from maintenance_health_v
   where enabled and status <> 'в норме'
$$;

comment on function app.maintenance_overdue is
  'Инвариант 16. Сколько плановых работ не в норме. Ненулевое значение означает, что планировщик не делает свою работу.';

-- ---------------------------------------------------------------------------
-- Регистрация расписания в pg_cron
-- ---------------------------------------------------------------------------
-- Вызывается один раз руками после развёртывания и повторно после любой
-- правки maintenance_jobs. Идемпотентна: повторный вызов перерегистрирует.

create or replace function app.install_schedule()
  returns table (job text, action text)
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r      record;
  v_name text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron не установлен в этой базе. Нужно: расширение pg_cron в кластере (shared_preload_libraries), cron.database_name = текущая база, затем create extension pg_cron. Без pg_cron расписание ведёт внешний cron вызовом app.run_maintenance_all()'
      using errcode = 'feature_not_supported';
  end if;

  for r in select mj.job, mj.cron_expression, mj.enabled from maintenance_jobs mj order by mj.job loop
    -- Имя с префиксом: в кластере может жить чужое расписание.
    v_name := 'partner_' || r.job;

    if exists (select 1 from cron.job c where c.jobname = v_name) then
      perform cron.unschedule(v_name);
    end if;

    if r.enabled then
      -- Имя работы подставляется из таблицы, но не как текст запроса:
      -- quote_literal закрывает дыру, а case в run_maintenance не даст
      -- выполнить ничего, кроме трёх известных работ.
      perform cron.schedule(v_name, r.cron_expression,
        format('select app.run_maintenance(%L)', r.job));
      return query select r.job, 'зарегистрирована: ' || r.cron_expression;
    else
      return query select r.job, 'снята с расписания (выключена)'::text;
    end if;
  end loop;
end $$;

comment on function app.install_schedule is
  'Инвариант 16. Регистрирует maintenance_jobs в pg_cron. Идемпотентна. Вызывается руками после развёртывания.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
-- Плановые работы выполняются от владельца: pg_cron ходит в базу под
-- postgres. Агенту они не нужны, админу нужен способ дёрнуть руками, когда
-- что-то подвисло. Поэтому ручной запуск — отдельная функция кабинета с
-- проверкой админа, а app.run_maintenance* никому из ролей не выдаётся.
--
-- Инвариант 15 проверит, что PUBLIC здесь ничего не получил.

revoke execute on function
  app.run_maintenance(text),
  app.run_maintenance_all(),
  app.install_schedule(),
  app.maintenance_overdue(),
  app.maintenance_runs_append_only()
  from public;

create or replace function run_maintenance_now(p_job text default null)
  returns table (job text, ok boolean, result jsonb, error text)
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if not app.is_admin() then
    raise exception 'FORBIDDEN: плановые работы запускает администратор'
      using errcode = 'insufficient_privilege';
  end if;

  if p_job is null then
    return query select * from app.run_maintenance_all();
  else
    v := app.run_maintenance(p_job);
    return query select p_job, (v ->> 'ok')::boolean, v -> 'result', v ->> 'error';
  end if;
end $$;

comment on function run_maintenance_now is
  'Инвариант 16. Ручной запуск плановых работ администратором: когда планировщик подвис, а ждать следующего часа нечего.';

-- Права на run_maintenance_now() здесь не ставятся: она в схеме public, а
-- права всех функций этой схемы приводит в порядок 0020 — одним проходом, не
-- перечисляя функции по именам. Отдельные revoke/grant тут стояли в первой
-- версии; мутационный тест показал, что их удаление ничего не меняет, то есть
-- они ничего и не делали. Мёртвая строка в правах хуже отсутствующей: она
-- создаёт впечатление, что что-то защищено именно ею.

grant select on maintenance_jobs, maintenance_runs, maintenance_health_v to authenticated;
grant execute on function app.maintenance_overdue() to authenticated;

alter table maintenance_jobs  enable row level security;
alter table maintenance_runs  enable row level security;

-- Состояние планировщика — не секрет от агентов: подвисшая очистка объясняет,
-- почему кандидат не освободился. На запись роли не выдано ничего, поэтому
-- отказ приходит ещё на правах, не доходя до построчных политик.
create policy maintenance_jobs_read on maintenance_jobs for select to authenticated using (true);
create policy maintenance_runs_read on maintenance_runs for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Выключение работы — событие, а не настройка
-- ---------------------------------------------------------------------------
-- Без этого у инварианта 16 оставалась дыра в собственном днище. Работа,
-- выключенная в maintenance_jobs, показывается как «выключена», то есть не
-- как поломка. Значит самый простой способ заглушить всю эту конструкцию —
-- не ломать её, а тихо снять галочку. Теперь такое снятие попадает в журнал
-- инварианта 7: кто, когда и что именно поменял.
--
-- maintenance_runs журнальным триггером НЕ накрыт, и это осознанно: он сам
-- журнал, дописывается триггером append-only, и каждый запуск дублировался бы
-- в audit_log целой строкой. Проверять журнал журналом незачем.

create trigger zz_audit_maintenance_jobs
  after insert or update or delete on maintenance_jobs
  for each row execute function app.write_audit('maintenance_job', 'id');
