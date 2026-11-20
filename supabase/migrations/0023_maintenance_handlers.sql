-- 0023_maintenance_handlers.sql
-- Инвариант 16, исправление устройства: работа расписания сама называет свой
-- обработчик, вместо того чтобы быть перечисленной в `case` внутри диспетчера.
--
-- ОТКУДА ЭТА МИГРАЦИЯ. В 0019 app.run_maintenance() разбирала имя работы
-- через case с тремя ветками и ветку else «для работы % нет кода». Решение
-- выглядело защищённым: имя из таблицы в SQL не подставляется, выполнить
-- постороннее нельзя.
--
-- Цена обнаружилась в первой же следующей миграции. 0022 добавила работу
-- purge_login_codes строкой в maintenance_jobs — и забыла ветку в case,
-- потому что это другой файл и другая мысль. Инвариант 16 сработал как
-- задумано: работа честно показала «для работы purge_login_codes нет кода»
-- вместо тихого молчания. Но правильнее, чтобы такую ошибку нельзя было
-- сделать: добавление работы должно быть одним действием, а не двумя в разных
-- местах.
--
-- КАК ТЕПЕРЬ. У работы есть обработчик — функция схемы app без аргументов,
-- возвращающая jsonb с результатом. Диспетчер вызывает её, ничего не зная о
-- списке работ.
--
-- Подстановки текста здесь по-прежнему нет: тип regprocedure хранит ссылку на
-- настоящую функцию, а не строку. Строку «drop table objects» в него не
-- записать — приведение к regprocedure её не разберёт.

-- ---------------------------------------------------------------------------
-- Обработчики: тонкие обёртки, приводящие результат к jsonb
-- ---------------------------------------------------------------------------
-- Обёртки нужны потому, что сами работы возвращают разное: число истёкших
-- мандатов, число освобождённых кандидатов, пару из удалённых телефонов и
-- записей. Диспетчеру нужен один вид ответа.

create or replace function app.job_expire_mandates() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('mandates_expired', app.expire_mandates())
$$;

create or replace function app.job_release_stale_claims() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('claims_released', app.release_stale_claims())
$$;

create or replace function app.job_purge_candidates() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('phones_removed', phones_removed,
                            'candidates_removed', candidates_removed)
    from app.purge_candidates()
$$;

create or replace function app.job_purge_login_codes() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('codes_removed', app.purge_login_codes())
$$;

-- ---------------------------------------------------------------------------
-- Работа называет свой обработчик
-- ---------------------------------------------------------------------------

alter table maintenance_jobs add column handler regprocedure;

update maintenance_jobs set handler = 'app.job_expire_mandates()'::regprocedure
 where job = 'expire_mandates';
update maintenance_jobs set handler = 'app.job_release_stale_claims()'::regprocedure
 where job = 'release_stale_claims';
update maintenance_jobs set handler = 'app.job_purge_candidates()'::regprocedure
 where job = 'purge_candidates';
update maintenance_jobs set handler = 'app.job_purge_login_codes()'::regprocedure
 where job = 'purge_login_codes';

alter table maintenance_jobs alter column handler set not null;

comment on column maintenance_jobs.handler is
  'Инвариант 16. Функция схемы app без аргументов, возвращающая jsonb. Работа без обработчика в таблицу не попадёт: столбец NOT NULL.';

-- Обработчик должен быть в схеме app: там живут внутренние функции, и там же
-- стоит запрет на вызов кем попало (инвариант 15). Обработчик в схеме public
-- оказался бы доступен кабинету как обычная функция.
create or replace function app.check_maintenance_handler() returns trigger
  language plpgsql as $$
begin
  -- Пустой обработчик — дело NOT NULL, а не этого триггера. Иначе он
  -- опережал бы ограничение и сообщал про «схему app, получено NULL», что
  -- объясняет не ту ошибку, которая случилась.
  if new.handler is null then
    return new;
  end if;

  if (select n.nspname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where p.oid = new.handler) is distinct from 'app' then
    raise exception 'INVARIANT_16: обработчик работы должен быть функцией схемы app, получено %',
      new.handler
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;

create trigger b_maintenance_handler
  before insert or update of handler on maintenance_jobs
  for each row execute function app.check_maintenance_handler();

-- ---------------------------------------------------------------------------
-- Диспетчер больше не знает список работ
-- ---------------------------------------------------------------------------

create or replace function app.run_maintenance(p_job text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_started timestamptz := clock_timestamp();
  v_result  jsonb;
  v_error   text;
  v_handler regprocedure;
  v_enabled boolean;
begin
  select enabled, handler into v_enabled, v_handler
    from maintenance_jobs where job = p_job;

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
    execute format('select %s', v_handler) into v_result;
  exception when others then
    v_error := SQLERRM;
  end;

  insert into maintenance_runs (job, started_at, finished_at, ok, result, error)
  values (p_job, v_started, clock_timestamp(), v_error is null, v_result, v_error);

  return jsonb_build_object('job', p_job, 'ok', v_error is null,
                            'result', v_result, 'error', v_error);
end $$;

comment on function app.run_maintenance is
  'Инвариант 16. Выполняет обработчик одной плановой работы и записывает результат в журнал. Не падает от падения работы.';

revoke execute on function
  app.run_maintenance(text),
  app.check_maintenance_handler(),
  app.job_expire_mandates(), app.job_release_stale_claims(),
  app.job_purge_candidates(), app.job_purge_login_codes()
  from public;
