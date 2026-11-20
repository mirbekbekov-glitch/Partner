-- 0034_email_identity.sql
-- ИНВАРИАНТ 6, ПЕРЕПИСАННЫЙ: один человек — один аккаунт по АДРЕСУ ПОЧТЫ.
--
-- Миграция 0011 сделала ключом личности телефон, и для рынка Бишкека это было
-- правильно: номер риелтора стоит на визитке, в объявлениях и в WhatsApp. Но
-- подтверждать телефон нечем, пока не подключён WhatsApp Business API, а это
-- деньги, проверка бизнеса в Meta и платёжный способ. Решение владельца
-- продукта: входим по почте сейчас, WhatsApp добавим потом.
--
-- ЧТО ЭТО СТОИТ, ЧЕСТНО. Почта как ключ слабее номера:
--
--   — ivan@mail.kg и ivan+1@mail.kg для базы два аккаунта, а в жизни один
--     человек. Склеивать их нормализацией нельзя: плюс-адресацию поддерживают
--     не все провайдеры, и «умная» нормализация однажды объединит двух разных
--     людей. Это хуже, чем два аккаунта у одного;
--   — почтовый ящик заводится за минуту, номер — нет;
--   — ящик теряют и взламывают чаще, чем сим-карту.
--
-- Поэтому единственной защитой от второго аккаунта остаётся одобрение
-- администратором (инвариант 17): до одобрения агент не может ничего, а
-- одобряющий знает своих людей в лицо. Это записано здесь, а не спрятано.
--
-- ЧТО ПРОИСХОДИТ С ТЕЛЕФОНОМ. Он остаётся, остаётся уникальным и перестаёт
-- быть обязательным: при регистрации по почте его взять неоткуда и
-- подтвердить нечем. Поэтому:
--
--   — телефон виден как НЕПОДТВЕРЖДЁННЫЙ, пока его не подтвердит код;
--   — смена телефона сбрасывает подтверждение: номер изменился — значит снова
--     не подтверждён;
--   — ни одно правило системы на agents.phone не опирается. Это проверяется
--     тестом: неподтверждённый номер не должен ничего открывать.
--
-- КОГДА ПРИДЁТ WHATSAPP. Канал кода становится данными, а не кодом: таблица
-- login_codes знает, по какому каналу и на какой адрес ушёл код, и
-- app.issue_login_code() принимает канал параметром. Добавление WhatsApp —
-- это строка в перечислении, ветка в отправщике и подтверждение телефона.
-- Ключ личности при этом трогать не придётся.

-- ---------------------------------------------------------------------------
-- Канал доставки кода
-- ---------------------------------------------------------------------------

create type login_channel as enum ('email', 'whatsapp');

comment on type login_channel is
  'Инвариант 18. Чем доставлен код входа. Канал — данные: добавление WhatsApp не меняет ни ключа личности, ни правил кода.';

-- ---------------------------------------------------------------------------
-- Нормализация адреса
-- ---------------------------------------------------------------------------
-- Только то, в чём нельзя ошибиться: обрезка и нижний регистр. Точки в имени
-- ящика и плюс-адресацию НЕ трогаем — у Gmail они значат одно, у остальных
-- другое, и «умная» нормализация однажды сольёт два разных ящика в один
-- аккаунт. Два аккаунта у одного человека чинятся администратором; один
-- аккаунт на двух людей не чинится ничем.

create or replace function app.normalize_email(p_raw text) returns text
  language plpgsql immutable set search_path = pg_temp as $$
declare v text;
begin
  if p_raw is null then
    return null;
  end if;

  v := lower(btrim(p_raw));

  -- Проверка формы, а не существования: существование докажет код, который
  -- на этот адрес уйдёт. Здесь отсекается то, что заведомо не адрес.
  if v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then
    return null;
  end if;

  return v;
end $$;

comment on function app.normalize_email is
  'Инвариант 6. Адрес к нижнему регистру без пробелов. NULL означает, что это не адрес. Точки и плюс-адресацию не трогает сознательно.';

-- ---------------------------------------------------------------------------
-- Почта у агента
-- ---------------------------------------------------------------------------

alter table agents add column email text;
alter table agents add column email_verified_at timestamptz;

comment on column agents.email is
  'Инвариант 6: ключ личности. Нормализуется триггером a_agents_email.';
comment on column agents.email_verified_at is
  'Когда адрес подтверждён кодом. Без подтверждения аккаунта не существует: он и создаётся подтверждением.';

-- Как и в 0011 с телефоном: миграция отказывается превращать в ключ то, чего
-- у части строк нет. Молча придумать адрес — значит создать аккаунт, которым
-- никто не владеет.
do $$
declare v_count integer;
begin
  select count(*) into v_count from agents where email is null;
  if v_count > 0 then
    raise exception
      'Миграция 0034: у % агентов нет почты. Заполните agents.email до применения.',
      v_count;
  end if;
end $$;

create or replace function app.normalize_agent_email() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare v text;
begin
  if new.email is null or btrim(new.email) = '' then
    raise exception 'INVARIANT_6: аккаунт без адреса почты невозможен'
      using errcode = 'not_null_violation',
            hint = 'Адрес это ключ личности: один человек — один аккаунт.';
  end if;

  v := app.normalize_email(new.email);
  if v is null then
    raise exception 'INVARIANT_6: «%» не похоже на адрес почты', new.email
      using errcode = 'check_violation',
            hint = 'Ожидается вид имя@домен.зона.';
  end if;

  new.email := v;
  return new;
end $$;

create trigger a_agents_email
  before insert or update of email on agents
  for each row execute function app.normalize_agent_email();

alter table agents alter column email set not null;
create unique index agents_email_key on agents (email);

-- ---------------------------------------------------------------------------
-- Телефон: остаётся, но перестаёт быть ключом
-- ---------------------------------------------------------------------------
-- Уникальность сохраняется: два агента с одним номером это всё равно ошибка.
-- NULL при этом уникальности не мешает — их может быть сколько угодно.

alter table agents alter column phone drop not null;

comment on column agents.phone is
  'Телефон агента. С 0034 не ключ личности и не обязателен: при регистрации по почте его неоткуда взять и нечем подтвердить. Уникален, когда задан.';

-- Триггер нормализации из 0011 требовал телефон обязательным. Теперь пустой
-- телефон — это отсутствие телефона, а не ошибка.
create or replace function app.normalize_agent_phone() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare v text;
begin
  if new.phone is null or btrim(new.phone) = '' then
    new.phone := null;
    new.phone_verified_at := null;
    return new;
  end if;

  v := app.normalize_phone(new.phone);
  if v is null then
    raise exception 'INVARIANT_6: «%» не похоже на номер телефона', new.phone
      using errcode = 'check_violation',
            hint = 'Ожидается 0XXXXXXXXX, 996XXXXXXXXX или международный +...';
  end if;

  -- Номер изменился — значит он снова неподтверждённый. Иначе подтверждение,
  -- полученное для одного номера, досталось бы другому.
  if tg_op = 'UPDATE' and v is distinct from old.phone then
    new.phone_verified_at := null;
  end if;

  new.phone := v;
  return new;
end $$;

comment on function app.normalize_agent_phone is
  'Инвариант 6. Номер к E.164. Пустой номер допустим: ключ личности теперь почта. Смена номера сбрасывает подтверждение.';

alter table agents add constraint agents_verified_phone_exists
  check (phone_verified_at is null or phone is not null);

-- ---------------------------------------------------------------------------
-- Вход по почте
-- ---------------------------------------------------------------------------

create or replace function app.current_email() returns text
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select app.normalize_email(nullif(auth.jwt() ->> 'email', ''))
$$;

comment on function app.current_email is
  'Подтверждённый адрес из клеймов входа. Не из формы и не из параметра: клеймы ставит служба входа после проверки кода.';

create or replace function app.login_by_email(
  p_full_name text default null,
  p_phone     text default null
) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_email text := app.current_email();
  v_uid   uuid := auth.uid();
  r       agents;
begin
  if v_email is null then
    raise exception 'INVARIANT_6: во входе нет подтверждённого адреса почты'
      using errcode = '42501',
            hint = 'Сначала подтвердите адрес кодом, затем вызывайте вход.';
  end if;

  insert into agents (email, phone, full_name, auth_user_id, email_verified_at)
  values (v_email,
          nullif(btrim(coalesce(p_phone, '')), ''),
          coalesce(nullif(btrim(p_full_name), ''), v_email),
          v_uid,
          now())
  on conflict (email) do update
     set full_name         = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         auth_user_id      = coalesce(excluded.auth_user_id, agents.auth_user_id),
         email_verified_at = now(),
         updated_at        = now()
  returning * into r;

  return r;
end $$;

comment on function app.login_by_email is
  'Инвариант 6. Вход по подтверждённому адресу из клеймов. Повторный вход обновляет существующую строку, а не создаёт вторую. Телефон принимается только при создании: менять его входом нельзя, для этого есть профиль.';

-- Вход по телефону убирается целиком. Урок из 0011, где так же убрали вход по
-- телеграму: оставить функцию значит оставить второй способ создать аккаунт,
-- то есть вторую дырку в инварианте 6.
drop function if exists app.login_by_phone(text);

-- ---------------------------------------------------------------------------
-- Коды входа: адрес и канал вместо номера
-- ---------------------------------------------------------------------------

alter table login_codes add column channel login_channel not null default 'email';
alter table login_codes add column address text;

update login_codes set address = phone where address is null;
delete from login_codes where address is null;

alter table login_codes alter column address set not null;
alter table login_codes drop column phone;

drop index if exists login_codes_phone_idx;
create index login_codes_address_idx on login_codes (address, channel, created_at desc);

comment on column login_codes.address is
  'Куда ушёл код: адрес почты или номер телефона — смотря какой канал.';
comment on column login_codes.channel is
  'Чем доставлен код. Ограничения «пять попыток» и «пять кодов в час» считаются по паре адрес+канал.';

create or replace function app.normalize_login_address(
  p_raw     text,
  p_channel login_channel
) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select case p_channel
           when 'email'    then app.normalize_email(p_raw)
           when 'whatsapp' then app.normalize_phone(p_raw)
         end
$$;

comment on function app.normalize_login_address is
  'Инвариант 18. Адрес приводится к виду, годному для ключа, по правилам своего канала.';

-- ---------------------------------------------------------------------------
-- Выдача и проверка кода по любому каналу
-- ---------------------------------------------------------------------------
-- Тело правил не меняется — меняется только то, чем считается адрес. Старые
-- однопараметрические функции убираются: оставить их значило бы оставить путь
-- входа, который ничего не знает о каналах.

drop function if exists app.issue_login_code(text);
drop function if exists app.verify_login_code(text, text);

create or replace function app.issue_login_code(
  p_address text,
  p_channel login_channel default 'email'
) returns table (code text, expires_at timestamptz, address text, channel login_channel)
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_addr   text := app.normalize_login_address(p_address, p_channel);
  v_code   text;
  v_recent integer;
begin
  -- Адрес нормализуется тем же кодом, что и адрес агента: иначе «Ivan@Mail.kg»
  -- и «ivan@mail.kg» были бы разными адресами, и ограничение на выдачи
  -- обходилось бы сменой регистра.
  if v_addr is null then
    raise exception 'INVARIANT_18: «%» не похоже на адрес канала %', p_address, p_channel
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_recent
    from login_codes lc
   where lc.address = v_addr and lc.channel = p_channel
     and lc.created_at > now() - interval '1 hour';

  if v_recent >= app.login_code_max_per_hour() then
    raise exception 'INVARIANT_18: на % уже отправлено % кодов за час, подождите',
      v_addr, v_recent
      using errcode = 'too_many_rows',
            hint = 'Ограничение защищает владельца адреса от спама, а нас от счёта за сообщения.';
  end if;

  -- Шесть цифр, включая ведущие нули: код «000123» так же валиден, как
  -- «913247», и терять из-за форматирования шестую часть вариантов незачем.
  v_code := lpad((random() * 999999)::integer::text, 6, '0');

  -- Прошлые невыбранные коды этого адреса гасятся: иначе в живых оказывались
  -- бы сразу несколько, и одноразовость превращалась бы в «пятиразовость».
  update login_codes lc set consumed_at = now()
   where lc.address = v_addr and lc.channel = p_channel
     and lc.consumed_at is null and lc.expires_at > now();

  insert into login_codes (address, channel, code_hash, expires_at)
  values (v_addr, p_channel, crypt(v_code, gen_salt('bf')), now() + app.login_code_ttl());

  return query select v_code, now() + app.login_code_ttl(), v_addr, p_channel;
end $$;

comment on function app.issue_login_code is
  'Инвариант 18. Выдаёт код входа и возвращает его службе для отправки. Гасит прошлые коды адреса, ограничивает частоту. Канал — параметр: добавление WhatsApp не меняет правил.';

create or replace function app.verify_login_code(
  p_address text,
  p_code    text,
  p_channel login_channel default 'email'
) returns table (ok boolean, reason text, auth_user_id uuid, address text, is_new boolean)
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_addr text := app.normalize_login_address(p_address, p_channel);
  rec    login_codes;
  v_uid  uuid;
begin
  if v_addr is null then
    raise exception 'INVARIANT_18: «%» не похоже на адрес канала %', p_address, p_channel
      using errcode = 'invalid_parameter_value';
  end if;

  select * into rec
    from login_codes lc
   where lc.address = v_addr and lc.channel = p_channel and lc.consumed_at is null
   order by lc.created_at desc
   limit 1;

  if rec.id is null then
    return query select false, 'код не запрашивался или уже использован', null::uuid, v_addr, null::boolean;
    return;
  end if;

  if rec.expires_at <= now() then
    return query select false, 'срок кода истёк', null::uuid, v_addr, null::boolean;
    return;
  end if;

  if rec.attempts >= app.login_code_max_attempts() then
    update login_codes lc set consumed_at = now() where lc.id = rec.id;
    return query select false, 'попытки исчерпаны, запросите новый код', null::uuid, v_addr, null::boolean;
    return;
  end if;

  -- Попытка считается ДО сравнения, и запись о ней остаётся: функция не
  -- поднимает исключение, значит транзакция не откатывается, значит счётчик
  -- не обнулить ни неверным кодом, ни обрывом соединения.
  update login_codes lc set attempts = lc.attempts + 1 where lc.id = rec.id;

  if crypt(coalesce(p_code, ''), rec.code_hash) <> rec.code_hash then
    return query select false, 'код неверный', null::uuid, v_addr, null::boolean;
    return;
  end if;

  update login_codes lc set consumed_at = now() where lc.id = rec.id;

  -- Кто вошёл. У вернувшегося агента свой auth_user_id уже есть; новому
  -- человеку он выдаётся здесь, и дальше app.login_by_email() создаёт по нему
  -- агента со статусом «ожидает одобрения».
  --
  -- Код, пришедший на телефон, тоже опознаёт агента — по телефону. Но это
  -- работает только для ПОДТВЕРЖДЁННОГО номера: неподтверждённый вписан со
  -- слов человека, и пускать по нему в чужой аккаунт нельзя.
  if p_channel = 'email' then
    select a.auth_user_id into v_uid from agents a where a.email = v_addr;
  else
    select a.auth_user_id into v_uid from agents a
     where a.phone = v_addr and a.phone_verified_at is not null;
  end if;

  return query select true, null::text,
                      coalesce(v_uid, gen_random_uuid()), v_addr, v_uid is null;
end $$;

comment on function app.verify_login_code is
  'Инвариант 18. Проверяет код: одноразово, со сроком и со счётчиком попыток. Неудача возвращается ответом, иначе откат транзакции обнулял бы счётчик. По телефону опознаёт только подтверждённый номер.';

-- ---------------------------------------------------------------------------
-- Что видно агенту
-- ---------------------------------------------------------------------------

-- Столбцы вида меняются местами, а `create or replace view` переименовывать
-- их не умеет. Пересоздаём: на me_v ничего не ссылается, кроме кабинета.
drop view if exists me_v;

create view me_v
  with (security_invoker = true) as
select a.id, a.full_name, a.email, a.phone, a.role, a.status,
       a.email_verified_at, a.phone_verified_at,
       a.telegram_id, a.created_at,
       app.is_admin() as is_admin
  from agents a
 where a.auth_user_id = auth.uid();

comment on view me_v is
  'Текущий вошедший агент. Пустая выборка означает, что входа нет или агент не одобрен.';

-- Пересозданный вид теряет права вместе со старым. Это тот случай, когда
-- молчаливая потеря прав выглядит как поломка кабинета, а не как отказ.
grant select on me_v to authenticated;
revoke all on me_v from anon;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
-- Агент правит своё имя, телеграм и телефон. Почту — нет: это ключ личности,
-- и смена ключа подтверждается кодом, а не формой. Пока такого пути нет,
-- адрес меняет администратор.

grant update (full_name, telegram_id, phone) on agents to authenticated;

revoke execute on function
  app.normalize_email(text),
  app.normalize_agent_email(),
  app.normalize_login_address(text, login_channel),
  app.current_email(),
  app.login_by_email(text, text),
  app.issue_login_code(text, login_channel),
  app.verify_login_code(text, text, login_channel)
  from public;

grant execute on function
  app.normalize_email(text),
  app.current_email(),
  app.login_by_email(text, text)
  to authenticated;

grant execute on function
  app.normalize_email(text),
  app.normalize_phone(text),
  app.normalize_login_address(text, login_channel),
  app.issue_login_code(text, login_channel),
  app.verify_login_code(text, text, login_channel),
  app.login_by_email(text, text)
  to auth_service;
