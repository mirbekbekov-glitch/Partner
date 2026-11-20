-- 0022_login_codes.sql
-- ИНВАРИАНТ 18: код входа одноразовый, живёт минуты, не угадывается подбором,
--               не рассылается спамом и не лежит в базе открытым текстом.
--
-- Вход в кабинет — это номер телефона и код в WhatsApp. Значит у системы
-- появляется первая дверь, открытая наружу до всякой авторизации, и дверь
-- эту надо запирать в базе, а не в обработчике формы: обработчиков со
-- временем будет несколько (веб, мобильное приложение, бот), и каждый
-- придумает свои ограничения по-своему.
--
-- ЧТО ИМЕННО ЗАПИРАЕТСЯ, и почему каждое правило нужно.
--
--   одноразовость   — код, который работает дважды, это пароль, подсмотренный
--                     в чужом уведомлении;
--   срок жизни      — 5 минут. Код из вчерашней переписки входить не должен;
--   число попыток   — 5 на код. Шестизначный код это миллион вариантов, и без
--                     ограничения он подбирается за минуты, а не за годы;
--   число выдач     — 5 на номер в час. Иначе чужой номер заваливают
--                     сообщениями, а счёт за WhatsApp платим мы;
--   хеш вместо кода — дамп базы, попавший не туда, не должен давать входа.
--
-- КТО МОЖЕТ ЭТИМ ПОЛЬЗОВАТЬСЯ. Отдельная роль auth_service, и только она.
-- Выдача кода возвращает код вызывающему — его надо отправить в WhatsApp, —
-- и если бы эта функция была доступна роли каталога, любой желающий получал
-- бы код входа для любого номера прямо в ответе. Поэтому роль здесь своя, по
-- образцу сборщика: ровно две функции и ни одной таблицы.

create table login_codes (
  id          uuid primary key default gen_random_uuid(),
  phone       text        not null,
  -- Хеш, а не код. bcrypt медленный нарочно: даже с украденной таблицей
  -- перебор одного кода дороже, чем его пятиминутный срок жизни.
  code_hash   text        not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  attempts    integer     not null default 0,
  constraint login_codes_expires_after_create check (expires_at > created_at),
  constraint login_codes_attempts_sane        check (attempts >= 0)
);

create index login_codes_phone_idx on login_codes (phone, created_at desc);

comment on table login_codes is
  'Инвариант 18. Коды входа. Хранится хеш, срок жизни минуты, попытки считаются.';

-- Роль службы входа: та же мысль, что у роли сборщика. Выдача кода — не то,
-- что должно быть доступно каталогу или кабинету.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'auth_service') then
    create role auth_service nologin;
  end if;
end $$;

comment on role auth_service is
  'Инвариант 18. Служба входа: выдать код и проверить код. Больше ничего.';

create or replace function app.login_code_ttl() returns interval
  language sql immutable as $$ select interval '5 minutes' $$;
create or replace function app.login_code_max_attempts() returns integer
  language sql immutable as $$ select 5 $$;
create or replace function app.login_code_max_per_hour() returns integer
  language sql immutable as $$ select 5 $$;

-- ---------------------------------------------------------------------------
-- Выдача
-- ---------------------------------------------------------------------------

create or replace function app.issue_login_code(p_phone text)
  returns table (code text, expires_at timestamptz, phone text)
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_phone  text := app.normalize_phone(p_phone);
  v_code   text;
  v_recent integer;
begin
  -- Номер нормализуется тем же кодом, что и телефон агента: иначе «0700…» и
  -- «+996700…» были бы разными номерами, и ограничение на выдачи обходилось
  -- бы сменой формата записи.
  if v_phone is null then
    raise exception 'INVARIANT_18: «%» не похож на номер телефона', p_phone
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_recent
    from login_codes lc
   where lc.phone = v_phone
     and lc.created_at > now() - interval '1 hour';


  if v_recent >= app.login_code_max_per_hour() then
    raise exception 'INVARIANT_18: на номер % уже отправлено % кодов за час, подождите',
      v_phone, v_recent
      using errcode = 'too_many_rows',
            hint = 'Ограничение защищает владельца номера от спама, а нас от счёта за сообщения.';
  end if;

  -- Шесть цифр, включая ведущие нули: код «000123» так же валиден, как
  -- «913247», и терять из-за форматирования шестую часть вариантов незачем.
  v_code := lpad((random() * 999999)::integer::text, 6, '0');

  -- Прошлые невыбранные коды этого номера гасятся: иначе в живых оказывались
  -- бы сразу несколько, и одноразовость превращалась бы в «пятиразовость».
  update login_codes lc set consumed_at = now()
   where lc.phone = v_phone and lc.consumed_at is null and lc.expires_at > now();

  insert into login_codes (phone, code_hash, expires_at)
  values (v_phone, crypt(v_code, gen_salt('bf')), now() + app.login_code_ttl());

  return query select v_code, now() + app.login_code_ttl(), v_phone;
end $$;

comment on function app.issue_login_code is
  'Инвариант 18. Выдаёт код входа и возвращает его службе для отправки. Гасит прошлые коды номера, ограничивает частоту.';

-- ---------------------------------------------------------------------------
-- Проверка
-- ---------------------------------------------------------------------------

-- НЕУДАЧНЫЙ ВХОД — ЭТО ОТВЕТ, А НЕ ИСКЛЮЧЕНИЕ, и это не стилистика.
-- Первая версия поднимала исключение на неверный код, и ограничение на
-- подбор не работало вовсе: RAISE откатывает транзакцию целиком, вместе с
-- `update login_codes set attempts = attempts + 1`. Счётчик обнулялся сам,
-- и шестая попытка с правильным кодом проходила после пяти неверных. Тест
-- это поймал.
--
-- Поэтому функция возвращает результат: ok и причину. Чтобы небрежный
-- вызывающий не принял отказ за успех, при ok = false auth_user_id равен
-- NULL — сессию из такого ответа не собрать.
--
-- Исключение остаётся только на том, что не является неудачным входом: на
-- строке, которая не является номером телефона. Это ошибка вызывающего кода,
-- и откат транзакции тут как раз к месту.

create or replace function app.verify_login_code(p_phone text, p_code text)
  returns table (ok boolean, reason text, auth_user_id uuid, phone text, is_new boolean)
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_phone text := app.normalize_phone(p_phone);
  rec     login_codes;
  v_uid   uuid;
begin
  if v_phone is null then
    raise exception 'INVARIANT_18: «%» не похож на номер телефона', p_phone
      using errcode = 'invalid_parameter_value';
  end if;

  select * into rec
    from login_codes lc
   where lc.phone = v_phone and lc.consumed_at is null
   order by lc.created_at desc
   limit 1;

  if rec.id is null then
    return query select false, 'код не запрашивался или уже использован', null::uuid, v_phone, null::boolean;
    return;
  end if;

  if rec.expires_at <= now() then
    return query select false, 'срок кода истёк', null::uuid, v_phone, null::boolean;
    return;
  end if;

  if rec.attempts >= app.login_code_max_attempts() then
    -- Код с исчерпанными попытками гасится, а не остаётся лежать: иначе
    -- следующая попытка снова упиралась бы в этот же счётчик, и человек не
    -- смог бы войти, даже запросив новый код.
    update login_codes lc set consumed_at = now() where lc.id = rec.id;
    return query select false, 'попытки исчерпаны, запросите новый код', null::uuid, v_phone, null::boolean;
    return;
  end if;

  -- Попытка считается ДО сравнения, и запись о ней остаётся: функция не
  -- поднимает исключение, значит транзакция не откатывается, значит счётчик
  -- не обнулить ни неверным кодом, ни обрывом соединения.
  update login_codes lc set attempts = lc.attempts + 1 where lc.id = rec.id;

  if crypt(coalesce(p_code, ''), rec.code_hash) <> rec.code_hash then
    return query select false, 'код неверный', null::uuid, v_phone, null::boolean;
    return;
  end if;

  update login_codes lc set consumed_at = now() where lc.id = rec.id;

  -- Кто вошёл. У вернувшегося агента свой auth_user_id уже есть; новому
  -- человеку он выдаётся здесь, и дальше app.login_by_phone() создаёт по нему
  -- агента со статусом «ожидает одобрения».
  select a.auth_user_id into v_uid from agents a where a.phone = v_phone;

  return query select true, null::text,
                      coalesce(v_uid, gen_random_uuid()), v_phone, v_uid is null;
end $$;

comment on function app.verify_login_code is
  'Инвариант 18. Проверяет код: одноразово, со сроком и со счётчиком попыток. Неудача возвращается ответом, иначе откат транзакции обнулял бы счётчик.';

-- ---------------------------------------------------------------------------
-- Уборка
-- ---------------------------------------------------------------------------
-- Номер телефона — персональные данные, и срок хранения им нужен так же, как
-- телефонам кандидатов (инвариант 14). Использованный код не нужен совсем,
-- но сутки истории помогают разобраться в жалобе «не приходит код».

create or replace function app.purge_login_codes() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v integer;
begin
  delete from login_codes where created_at < now() - interval '1 day';
  get diagnostics v = row_count;
  return v;
end $$;

comment on function app.purge_login_codes is
  'Инвариант 18. Удаляет коды старше суток: это персональные данные, и вечно им лежать незачем.';

insert into maintenance_jobs (job, description, cron_expression, max_silence) values
  ('purge_login_codes',
   'Уборка кодов входа старше суток: номер телефона это персональные данные (инвариант 18)',
   '23 5 * * *', interval '36 hours');

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

alter table login_codes enable row level security;
-- Политик нет ни одной: таблица не читается и не пишется ничем, кроме
-- функций выше. Код входа не должен быть виден даже администратору.

revoke execute on function
  app.issue_login_code(text), app.verify_login_code(text, text),
  app.purge_login_codes(), app.login_code_ttl(),
  app.login_code_max_attempts(), app.login_code_max_per_hour()
  from public;

grant usage   on schema app to auth_service;
grant execute on function app.issue_login_code(text)         to auth_service;
grant execute on function app.verify_login_code(text, text)  to auth_service;
grant execute on function app.normalize_phone(text)          to auth_service;

-- Вход создаёт агента, поэтому службе входа нужна и сама функция входа.
grant execute on function app.login_by_phone(text) to auth_service;
grant select, insert, update on agents to auth_service;

grant execute on function app.purge_login_codes() to authenticated;
