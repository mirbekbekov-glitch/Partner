-- 0011_phone_identity.sql
-- ИНВАРИАНТ 6, вторая редакция: один человек — один аккаунт по номеру телефона.
--
-- Было: ключом личности был Telegram. agents.telegram_id NOT NULL UNIQUE и
-- app.login_by_telegram() — это и был весь механизм инварианта 6.
--
-- Кабинет решено делать обычным веб-приложением, не привязанным к Telegram,
-- со входом по одноразовому коду в WhatsApp. Значит ключ личности меняется на
-- номер телефона, а Telegram остаётся необязательным полем для связи.
--
-- Главное в этой миграции — НОРМАЛИЗАЦИЯ. Без неё инварианта нет: один и тот
-- же человек, введя «+996 700 111-222» и «0700111222», получил бы два
-- аккаунта, и UNIQUE этого не заметил бы. Поэтому нормализация живёт в базе
-- триггером, а не в клиенте: клиентов будет несколько (веб, потом мобильное
-- приложение), и каждый нормализовал бы по-своему.
--
-- Второе: телефон НЕ принимается в аргументе функции входа. Он читается из
-- проверенных клеймов JWT. Иначе любой вошедший агент мог бы назвать чужой
-- номер и занять чужой аккаунт.

-- ---------------------------------------------------------------------------
-- Нормализация номера
-- ---------------------------------------------------------------------------
-- Приводим к E.164. Местный формат Бишкека — 0XXX XXXXXX, десять цифр с нуля.
-- NULL на выходе означает «это не номер», и вызывающий триггер скажет об этом
-- внятно, вместо того чтобы молча записать мусор.

create or replace function app.normalize_phone(p_raw text) returns text
  language plpgsql immutable as $$
declare
  v_digits text;
  v_plus   boolean;
begin
  if p_raw is null then
    return null;
  end if;

  v_plus   := left(btrim(p_raw), 1) = '+';
  v_digits := regexp_replace(p_raw, '[^0-9]', '', 'g');

  if v_digits = '' then
    return null;
  end if;

  -- Уже с кодом страны Кыргызстана, со знаком плюс или без.
  if length(v_digits) = 12 and left(v_digits, 3) = '996' then
    return '+' || v_digits;
  end if;

  -- Местный формат: 0700111222.
  if length(v_digits) = 10 and left(v_digits, 1) = '0' then
    return '+996' || right(v_digits, 9);
  end if;

  -- Без нуля и без кода страны: 700111222.
  if length(v_digits) = 9 then
    return '+996' || v_digits;
  end if;

  -- Иностранный номер принимается только в явном международном виде:
  -- угадывать код страны по длине — это выдумывать данные.
  if v_plus and length(v_digits) between 8 and 15 then
    return '+' || v_digits;
  end if;

  return null;
end $$;

comment on function app.normalize_phone is
  'Инвариант 6. Номер к E.164. Местный формат 0XXXXXXXXX и 996XXXXXXXXX приводятся к +996XXXXXXXXX. NULL означает, что это не номер.';

-- ---------------------------------------------------------------------------
-- Телефон становится ключом личности
-- ---------------------------------------------------------------------------

-- Миграция рассчитана на пустую или полностью заполненную таблицу: гадать
-- телефон существующего агента нельзя, поэтому лучше остановиться громко.
do $$
begin
  if exists (select 1 from agents where phone is null) then
    raise exception
      'Миграция 0011: у % агентов нет телефона. Заполните agents.phone до применения.',
      (select count(*) from agents where phone is null);
  end if;
end $$;

alter table agents add column phone_verified_at timestamptz;

comment on column agents.phone_verified_at is
  'Когда номер подтверждён кодом. Ставится входом, вручную не писать.';

-- Telegram перестаёт быть ключом: остаётся необязательным полем для связи.
-- UNIQUE сохраняется — две записи на один Telegram по-прежнему бессмысленны,
-- а NULL в Postgres уникальности не нарушает.
alter table agents alter column telegram_id drop not null;

comment on column agents.telegram_id is
  'Необязательный контакт. Ключом личности был до 0011, теперь ключ это phone.';

-- ---------------------------------------------------------------------------
-- Нормализация на записи: это и есть инвариант 6
-- ---------------------------------------------------------------------------
-- Триггер, а не проверка в клиенте. Клиентов будет несколько, и каждый
-- нормализовал бы по-своему; UNIQUE же сравнивает строки буквально.

create or replace function app.normalize_agent_phone() returns trigger
  language plpgsql as $$
declare v text;
begin
  if new.phone is null or btrim(new.phone) = '' then
    raise exception 'INVARIANT_6: аккаунт без номера телефона невозможен'
      using errcode = 'not_null_violation',
            hint = 'Номер это ключ личности: один человек — один аккаунт.';
  end if;

  v := app.normalize_phone(new.phone);
  if v is null then
    raise exception 'INVARIANT_6: «%» не похоже на номер телефона', new.phone
      using errcode = 'check_violation',
            hint = 'Ожидается 0XXXXXXXXX, 996XXXXXXXXX или международный +...';
  end if;

  new.phone := v;
  return new;
end $$;

create trigger a_agents_phone
  before insert or update of phone on agents
  for each row execute function app.normalize_agent_phone();

-- Теперь, когда любая запись нормализована, телефон можно сделать ключом.
alter table agents alter column phone set not null;
create unique index agents_phone_key on agents (phone);

comment on column agents.phone is
  'Инвариант 6: ключ личности. Хранится в E.164, нормализуется триггером a_agents_phone.';

-- ---------------------------------------------------------------------------
-- Проверенный номер текущего входа
-- ---------------------------------------------------------------------------
-- Supabase кладёт подтверждённый номер в клейм phone, обычно без плюса.

create or replace function app.current_phone() returns text
  language sql stable as $$
  select app.normalize_phone(nullif(auth.jwt() ->> 'phone', ''))
$$;

comment on function app.current_phone is
  'Инвариант 6. Номер из проверенных клеймов JWT, а не из аргумента запроса.';

-- ---------------------------------------------------------------------------
-- Вход
-- ---------------------------------------------------------------------------
-- Номер в аргументах не принимается сознательно: иначе вошедший агент мог бы
-- назвать чужой номер и занять чужой аккаунт. ON CONFLICT по phone
-- гарантирует, что повторный вход обновляет строку, а не создаёт вторую,
-- поэтому agents.id не меняется и все ссылки на объекты, мандаты и подборы
-- остаются целыми.

create or replace function app.login_by_phone(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_phone text := app.current_phone();
  v_uid   uuid := auth.uid();
  r       agents;
begin
  if v_phone is null then
    raise exception 'INVARIANT_6: во входе нет подтверждённого номера телефона'
      using errcode = '42501',
            hint = 'Сначала подтвердите номер кодом, затем вызывайте вход.';
  end if;

  insert into agents (phone, full_name, auth_user_id, phone_verified_at)
  values (v_phone, coalesce(nullif(btrim(p_full_name), ''), v_phone), v_uid, now())
  on conflict (phone) do update
     set full_name         = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         auth_user_id      = coalesce(excluded.auth_user_id, agents.auth_user_id),
         phone_verified_at = now(),
         updated_at        = now()
  returning * into r;

  return r;
end $$;

comment on function app.login_by_phone is
  'Инвариант 6. Вход по подтверждённому номеру из JWT. Повторный вход обновляет существующую строку, а не создаёт вторую.';

-- Telegram больше не путь входа: оставлять функцию значит оставлять второй
-- способ создать аккаунт, то есть вторую дырку в инварианте 6.
drop function if exists app.login_by_telegram(bigint, text, uuid);

grant execute on function
  app.normalize_phone(text),
  app.current_phone(),
  app.login_by_phone(text)
  to authenticated;
