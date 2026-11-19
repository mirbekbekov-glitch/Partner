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

-- Тесты работают от имени роли authenticated, значит помощники должны быть
-- ей доступны.
grant usage on schema test to authenticated, anon;
grant execute on all functions in schema test to authenticated, anon;
-- app-помощники нужны тестам целиком, включая те, что в 0006 не выдавались.
grant usage on schema app to anon;
grant execute on all functions in schema app to authenticated, anon;
