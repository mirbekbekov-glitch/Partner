-- tests/harness.sql — помощники тестов. Не миграция.

create schema if not exists test;

-- Утверждение.
create or replace function test.ok(p_cond boolean, p_label text) returns void
  language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'ПРОВАЛ: %', p_label using errcode = 'raise_exception';
  end if;
  raise notice '  ok   %', p_label;
end $$;

-- Равенство, с показом фактического значения в сообщении.
create or replace function test.eq(p_actual anyelement, p_expected anyelement, p_label text)
  returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ПРОВАЛ: % (ожидалось %, получено %)', p_label, p_expected, p_actual
      using errcode = 'raise_exception';
  end if;
  raise notice '  ok   % (= %)', p_label, p_actual;
end $$;

-- Ожидаем, что запрос УПАДЁТ, и упадёт по нужной причине.
-- Именно этим проверяются инварианты: тест обязан падать, если запрещённое
-- действие проходит.
create or replace function test.throws(p_sql text, p_expect text, p_label text)
  returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := SQLERRM;
    if position(p_expect in v_msg) = 0 then
      raise exception 'ПРОВАЛ: % — упало, но не с тем: %', p_label, v_msg
        using errcode = 'raise_exception';
    end if;
    raise notice '  ok   % (отказ: %)', p_label, left(v_msg, 70);
    return;
  end;
  raise exception 'ПРОВАЛ: % — запрещённое действие ПРОШЛО', p_label
    using errcode = 'raise_exception';
end $$;

-- Сколько строк видно текущей роли. Пустой результат от RLS не отличим от
-- отсутствия строк, поэтому в тестах инварианта 4 считаем именно видимость.
create or replace function test.visible_count(p_sql text) returns bigint
  language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into v;
  return v;
end $$;

-- Тесты работают от имени ролей authenticated и anon, значит помощники должны
-- быть доступны обеим.
grant usage on schema test to authenticated, anon, collector, auth_service, notifier;
grant execute on all functions in schema test to authenticated, anon, collector, auth_service, notifier;

-- Права на схему app харнесс НЕ раздаёт. Раньше раздавал — и из-за этого
-- тесты были зелёными, пока страница отчёта падала с «permission denied for
-- schema app»: в тестах аноним мог вызвать что угодно, а в продакшене не мог
-- ничего. Харнесс, который выдаёт больше прав, чем миграции, проверяет не ту
-- систему, которая поедет в бой. Нужные права выдают сами миграции.

-- ---------------------------------------------------------------------------
-- Рабочий час по Бишкеку
-- ---------------------------------------------------------------------------
-- Тесты показов не могут опираться на `now() + interval 'N days'`: прогон в
-- час ночи назначал бы показы на час ночи, и инвариант 26 отклонял бы их.
-- Дело не в инварианте — до него тесты просто зависели от времени суток, в
-- которое их запустили, и никто этого не замечал. У показа есть час, и в
-- тесте он тоже должен быть назван.

create or replace function test.at_hour(p_days integer, p_hour integer default 15)
  returns timestamptz
  language sql stable as $$
  select (((now() at time zone 'Asia/Bishkek')::date + p_days)::timestamp
          + make_interval(hours => p_hour)) at time zone 'Asia/Bishkek'
$$;

comment on function test.at_hour is
  'Метка времени в заданный час по Бишкеку, со сдвигом в днях. Отрицательный сдвиг — прошлое.';

-- Ближайшее законное время показа: не раньше чем через пару часов и не позже
-- чем через двадцать, то есть внутри срока уведомления о предстоящем показе.
-- Нужна по той же причине, что test.at_hour(): иначе проверка уведомлений
-- зависела бы от времени суток, в которое запустили прогон. Окно сужено до
-- [открытие, закрытие минус два часа], чтобы к результату можно было
-- прибавить час-другой и не выйти из рабочих часов (инвариант 26).

create or replace function test.soon(p_plus interval default interval '0')
  returns timestamptz
  language sql stable as $$
  with t as (
    select (now() at time zone 'Asia/Bishkek') + interval '3 hours' as guess
  )
  select (case
            when guess::time between app.showing_opens()
                                 and app.showing_closes() - interval '2 hours'
              then guess
            -- Дата берётся У GUESS, а не у «сегодня». После 21:00 по Бишкеку
            -- now() + 3 часа переваливает за полночь, и «сегодня + 08:00»
            -- давало время В ПРОШЛОМ: показ создавался задним числом (откат
            -- на двое суток инвариант 25 разрешает), уведомление о
            -- предстоящем не выпускалось, и инвариант 27 падал — но только
            -- у того, кто запускал прогон вечером.
            when guess::time < app.showing_opens()
              then guess::date + app.showing_opens()
            else (guess::date + 1) + app.showing_opens()
          end + p_plus) at time zone 'Asia/Bishkek'
  from t
$$;

comment on function test.soon is
  'Законное время показа в пределах срока уведомления о предстоящем, и ВСЕГДА в будущем. Прогон в три часа ночи, в полдень и в десять вечера обязан давать один результат.';
