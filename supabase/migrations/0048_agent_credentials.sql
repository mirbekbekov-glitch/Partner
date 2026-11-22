-- 0048_agent_credentials.sql
-- ИНВАРИАНТ 38: аттестация ТПП — это ЗАЯВЛЕНИЕ агента, пока её не подтвердил
--               администратор платформы; подтверждение держится на конкретном
--               номере и имеет срок, а истёкшее не действует.
--
-- Откуда это вообще: с 7 марта 2025 года постановлением кабмина обучение и
-- аттестация агентов риэлторских фирм поручены Торгово-промышленной палате
-- КР, а закон «О риэлторской деятельности» разрешает работать агентом только
-- прошедшему аттестацию. Сертификат выдаётся на пять лет. По данным палаты
-- на октябрь 2026 года риэлторов в стране около 3200, а обучение прошли 264 —
-- то есть «есть сертификат» сегодня отличает меньшинство, и именно поэтому
-- показывать его стоит, а врать им — нельзя.
--
-- ГЛАВНОЕ РЕШЕНИЕ. Онлайн-реестра, который можно спросить запросом, у палаты
-- пока нет. Значит проверка — ручная, и единственный честный способ это
-- показать: хранить номер как ЗАЯВЛЕННЫЙ и отдельно хранить факт, что его
-- сверили. Поле «сертифицирован» без второго факта — это галочка, которую
-- ставит себе сам агент, и на платформе «для профессионалов» она хуже, чем
-- ничего: она врёт коллеге из другого агентства, который по ней решает, вести
-- ли с ним сделку.
--
-- Это ровно устройство мандата: `contract_confirmed` отдельно от самого
-- договора. Там тот же вопрос — «бумага есть или на словах».
--
-- ПОДТВЕРЖДАЕТ АДМИНИСТРАТОР ПЛАТФОРМЫ, А НЕ РУКОВОДИТЕЛЬ АГЕНТСТВА, хотя по
-- инварианту 35 руководитель может в своём агентстве всё. Здесь — не может, и
-- причина не в недоверии: аттестацию агентства показывают ДРУГИМ агентствам,
-- и руководитель, подтверждающий сертификаты своих же агентов, подтверждает
-- их сам себе. Доверие, выданное самому себе, доверием не является.
--
-- СМЕНА НОМЕРА СБРАСЫВАЕТ ПОДТВЕРЖДЕНИЕ. Иначе путь очевиден: подать
-- настоящий номер, дождаться подтверждения, заменить на любой другой и
-- остаться «в реестре». Так же устроен телефон (phone_verified_at) и так же
-- устроен договор.
--
-- СРОК — ЭТО ФАКТ, А НЕ СТАТУС. «Истёк» нигде не хранится: он вычисляется из
-- даты. Хранимый статус означал бы плановую работу, которая его переставляет,
-- и день, когда она не сработала.

alter table agents
  add column avatar_key              text,
  add column certificate_no          text,
  add column certificate_issued_on   date,
  add column certificate_valid_to    date,
  add column certificate_confirmed_at timestamptz,
  add column certificate_confirmed_by uuid references agents (id);

comment on column agents.avatar_key is
  'Инвариант 38. Ключ аватара в хранилище. Файл создан нами: он проходит ту же трубу перекодирования, что фотографии объекта (инвариант 11).';
comment on column agents.certificate_no is
  'Инвариант 38. Номер сертификата ТПП со слов агента. Сам по себе ничего не доказывает.';
comment on column agents.certificate_confirmed_at is
  'Инвариант 38. Когда администратор платформы сверил номер с палатой. Сбрасывается при смене номера или дат.';

-- Форма ключа ограничена схемой — так же, как у фотографий объекта: выйти за
-- каталог агента нельзя даже ошибкой в коде приложения.
alter table agents add constraint agents_avatar_key_shape
  check (avatar_key is null
         or avatar_key ~ '^avatars/[0-9a-f-]{36}/[0-9a-f]{32}\.webp$');

alter table agents add constraint agents_certificate_no_shape
  check (certificate_no is null or length(btrim(certificate_no)) between 3 and 40);

-- Один сертификат — один агент. Это не формальность: номер и есть то, что
-- сверяют, и два агента с одним номером означают, что один из них врёт.
create unique index agents_certificate_no_idx
  on agents (upper(btrim(certificate_no))) where certificate_no is not null;

alter table agents add constraint agents_certificate_dates
  check (certificate_valid_to is null or certificate_issued_on is null
         or certificate_valid_to >= certificate_issued_on);

-- Подтверждение не бывает без номера: подтверждать нечего.
alter table agents add constraint agents_certificate_confirmed_needs_no
  check (certificate_confirmed_at is null or certificate_no is not null);

-- ---------------------------------------------------------------------------
-- Правила
-- ---------------------------------------------------------------------------

create or replace function app.check_agent_certificate() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  -- Ничего про сертификат не менялось — не наше дело.
  if new.certificate_no          is not distinct from old.certificate_no
     and new.certificate_issued_on is not distinct from old.certificate_issued_on
     and new.certificate_valid_to  is not distinct from old.certificate_valid_to
     and new.certificate_confirmed_at is not distinct from old.certificate_confirmed_at
     and new.certificate_confirmed_by is not distinct from old.certificate_confirmed_by then
    return new;
  end if;

  -- Заявленное изменилось — подтверждение больше не о нём. Сброс идёт ПЕРВЫМ
  -- и безусловно: он не проверка, которую можно обойти, а следствие.
  if new.certificate_no          is distinct from old.certificate_no
     or new.certificate_issued_on is distinct from old.certificate_issued_on
     or new.certificate_valid_to  is distinct from old.certificate_valid_to then
    new.certificate_confirmed_at := null;
    new.certificate_confirmed_by := null;
  end if;

  -- Подтвердить может только администратор платформы. Руководитель агентства
  -- здесь не власть: он подтверждал бы сам себе.
  if new.certificate_confirmed_at is not null
     and old.certificate_confirmed_at is null
     and auth.uid() is not null
     and not app.is_admin() then
    raise exception 'INVARIANT_38: аттестацию подтверждает администратор платформы'
      using errcode = '42501',
            hint = 'Номер и даты введите сами — их сверят с палатой.';
  end if;

  -- Подтвердивший — тот, кто это сделал, а не тот, кого передали в запросе.
  -- Поле, которое нельзя передать неправильно, надёжнее проверяемого.
  if new.certificate_confirmed_at is not null
     and old.certificate_confirmed_at is null then
    new.certificate_confirmed_by := coalesce(app.current_agent_id(), new.certificate_confirmed_by);
  end if;

  return new;
end $$;

comment on function app.check_agent_certificate is
  'Инвариант 38. Смена номера или дат сбрасывает подтверждение; подтверждает только администратор платформы, и подтвердивший выводится, а не принимается.';

create trigger b_agent_certificate
  before update on agents
  for each row execute function app.check_agent_certificate();

-- ---------------------------------------------------------------------------
-- Аттестация словами
-- ---------------------------------------------------------------------------
-- Четыре состояния, и они разные по смыслу, а не по оттенку:
--   нет         — номер не заявлен;
--   заявлен     — номер есть, его ещё не сверили;
--   подтверждён — сверили, и срок не вышел;
--   истёк       — сверяли, но срок вышел. Это НЕ «нет»: агент был в реестре,
--                 и коллеге важно знать разницу между «не проходил» и
--                 «проходил, пора продлевать».

create or replace function app.certificate_state(
  p_no text, p_confirmed_at timestamptz, p_valid_to date
) returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_no is null                                   then 'нет'
    when p_confirmed_at is null                         then 'заявлен'
    when p_valid_to is not null and p_valid_to < current_date then 'истёк'
    else 'подтверждён'
  end
$$;

comment on function app.certificate_state is
  'Инвариант 38. Состояние аттестации словами. «Истёк» вычисляется из даты и нигде не хранится: хранимый статус требовал бы работы, которая его переставляет, и дня, когда она не сработала.';

create or replace function app.is_certified(p_agent_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from agents a
     where a.id = p_agent_id
       and a.certificate_confirmed_at is not null
       and (a.certificate_valid_to is null or a.certificate_valid_to >= current_date))
$$;

comment on function app.is_certified is
  'Инвариант 38. Агент в реестре ТПП: номер сверен и срок не вышел. Единственный источник для плашки «в реестре».';

-- ---------------------------------------------------------------------------
-- Решения администратора
-- ---------------------------------------------------------------------------

create or replace function confirm_certificate(p_agent_id uuid) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  -- Роль здесь не проверяется: её проверяет триггер, и проверять дважды одно
  -- и то же значит иметь два места, которые можно разойтись. Мутационная
  -- проверка это и показала — снятая проверка в функции не роняла ни одного
  -- утверждения, потому что ловил триггер.
  select * into r from agents where id = p_agent_id;
  if r.id is null then
    raise exception 'агент % не существует', p_agent_id using errcode = 'no_data_found';
  end if;
  if r.certificate_no is null then
    raise exception 'INVARIANT_38: у агента не заявлен номер сертификата — подтверждать нечего'
      using errcode = 'check_violation';
  end if;

  update agents
     set certificate_confirmed_at = now(), updated_at = now()
   where id = p_agent_id
  returning * into r;
  return r;
end $$;

comment on function confirm_certificate is
  'Инвариант 38. Администратор платформы сверил номер с ТПП. Сверка ручная: онлайн-реестра, который можно спросить запросом, у палаты пока нет.';

create or replace function revoke_certificate(p_agent_id uuid, p_reason text)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r agents;
begin
  if not app.is_admin() then
    raise exception 'INVARIANT_38: аттестацию снимает администратор платформы'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'INVARIANT_38: у снятия аттестации должна быть причина'
      using errcode = 'not_null_violation',
            hint = 'Её прочитает агент, и по ней он поймёт, что исправлять.';
  end if;

  -- Номер остаётся: он заявлен, и то, что его когда-то сверяли и сняли, —
  -- это история, а не повод чистить поле. Снимается подтверждение.
  update agents
     set certificate_confirmed_at = null,
         certificate_confirmed_by = null,
         updated_at = now()
   where id = p_agent_id
  returning * into r;

  if r.id is null then
    raise exception 'агент % не существует', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function revoke_certificate is
  'Инвариант 38. Снять подтверждение аттестации с причиной. Номер остаётся заявленным.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------
-- Агент правит своё лицо и своё заявление. Подтверждение — не его столбец, и
-- это не проверка формы, а грант: формы, которой нет, всё равно не хватило бы.

grant update (full_name, telegram_id, phone, avatar_key,
              certificate_no, certificate_issued_on, certificate_valid_to)
  on agents to authenticated;

revoke execute on function
  app.check_agent_certificate(), app.certificate_state(text, timestamptz, date),
  app.is_certified(uuid), confirm_certificate(uuid), revoke_certificate(uuid, text)
  from public;

grant execute on function
  app.certificate_state(text, timestamptz, date), app.is_certified(uuid),
  confirm_certificate(uuid), revoke_certificate(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Где это видно
-- ---------------------------------------------------------------------------

drop view if exists me_v;

create view me_v
  with (security_invoker = true) as
select a.id, a.full_name, a.email, a.phone, a.role, a.status,
       a.email_verified_at, a.phone_verified_at,
       a.telegram_id, a.created_at,
       a.directions,
       a.avatar_key,
       a.certificate_no,
       a.certificate_issued_on,
       a.certificate_valid_to,
       a.certificate_confirmed_at,
       app.certificate_state(a.certificate_no, a.certificate_confirmed_at,
                             a.certificate_valid_to) as certificate_state,
       ag.id   as agency_id,
       ag.name as agency_name,
       app.is_admin() as is_admin,
       app.is_head()  as is_head
  from agents a
  join agencies ag on ag.id = a.agency_id
 where a.auth_user_id = auth.uid();

comment on view me_v is
  'Текущий вошедший агент. Пустая выборка означает, что входа нет или агент не одобрен.';

grant select on me_v to authenticated;
revoke all on me_v from anon;

-- Лицо и аттестация — то, ради чего коллега из другого агентства вообще сюда
-- смотрит. Номер сертификата при этом наружу не отдаётся: он нужен для
-- сверки, а не для показа, и чужой номер — это чужой документ. Отдаётся
-- ответ: в реестре или нет.
create or replace view platform_agents_v
  with (security_invoker = false) as
select a.id, a.full_name, a.status, ag.id as agency_id, ag.name as agency_name,
       app.same_agency(a.id) as mine,
       a.avatar_key,
       app.is_certified(a.id) as certified,
       app.certificate_state(a.certificate_no, a.certificate_confirmed_at,
                             a.certificate_valid_to) as certificate_state,
       a.certificate_valid_to
  from agents a join agencies ag on ag.id = a.agency_id
 where a.status = 'approved';

comment on view platform_agents_v is
  'Инварианты 33 и 38. Кто есть на платформе: имя, агентство, лицо и аттестация ТПП. Почты, телефона, телеграма и НОМЕРА сертификата чужого агента здесь нет.';

grant select on platform_agents_v to authenticated;
revoke all on platform_agents_v from anon;

-- Очередь администратора: кто заявил номер и ждёт сверки. Отдельное
-- представление, потому что это работа, а не справочник, — как очередь
-- обращений и очередь одобрения агентов.
create or replace view certificate_queue_v
  with (security_invoker = true) as
select a.id as agent_id, a.full_name, ag.name as agency_name,
       a.certificate_no, a.certificate_issued_on, a.certificate_valid_to,
       a.certificate_confirmed_at,
       app.certificate_state(a.certificate_no, a.certificate_confirmed_at,
                             a.certificate_valid_to) as state,
       c.full_name as confirmed_by_name
  from agents a
  join agencies ag on ag.id = a.agency_id
  left join agents c on c.id = a.certificate_confirmed_by
 where a.certificate_no is not null
 order by (a.certificate_confirmed_at is not null), a.full_name;

-- Состав агентства: лицо и аттестация рядом с именем. Представление своё,
-- политика на agents чужих агентств не показывает — эта строка её не
-- обходит, а только добавляет столбцы к тому, что и так видно.
-- Столбцы вставляются в середину, а create or replace переименовывать их
-- не умеет. Пересоздаём.
drop view if exists agency_agents_v;

create view agency_agents_v
  with (security_invoker = true) as
select
  a.id, a.full_name, a.phone, a.role, a.status, a.created_at, a.phone_verified_at,
  a.directions,
  a.avatar_key,
  app.certificate_state(a.certificate_no, a.certificate_confirmed_at,
                        a.certificate_valid_to) as certificate_state,
  a.certificate_valid_to,
  (select count(*) from objects o where o.created_by_agent_id = a.id) as objects_total,
  (select count(*) from mandates m
    where m.listing_agent_id = a.id and m.status = 'active')          as mandates_active,
  (select count(*) from deals d
    where d.status = 'closed'
      and (d.listing_agent_id = a.id or d.closing_agent_id = a.id))    as deals_closed
  from agents a
 order by
   case a.status when 'pending' then 0 when 'approved' then 1 else 2 end,
   a.full_name;

comment on view agency_agents_v is
  'Инварианты 17 и 38. Состав агентства: кто ждёт одобрения, у кого сколько работы, чьё лицо и чья аттестация.';

grant select on agency_agents_v to authenticated;
revoke all on agency_agents_v from anon;

-- Аттестация ведущего агента рядом с его объектом. Это продолжение того же
-- ответа, что тип договора: коллега из другого агентства решает, вести ли с
-- ним дело, и «в реестре ТПП» — часть этого решения. Номера здесь нет: он
-- нужен для сверки, а не для показа.
create or replace view app.object_terms_v
  with (security_invoker = false) as
select
  o.id                               as object_id,
  md.id is not null                  as has_mandate,
  md.kind                            as mandate_kind,
  md.contract_confirmed,
  md.valid_to,
  md.listing_agent_id,
  coalesce(md.listing_agent_id, o.created_by_agent_id) as holder_agent_id,
  coalesce(a.full_name, ca.full_name)                  as holder_agent_name,
  coalesce(ag.id, cag.id)                              as agency_id,
  coalesce(ag.name, cag.name)                          as agency_name,
  app.is_certified(coalesce(md.listing_agent_id, o.created_by_agent_id)) as holder_certified,
  coalesce(a.avatar_key, ca.avatar_key)                as holder_avatar_key
from objects o
left join mandates md on md.object_id = o.id and md.status = 'active'
left join agents a    on a.id = md.listing_agent_id
left join agencies ag on ag.id = a.agency_id
left join agents ca   on ca.id = o.created_by_agent_id
left join agencies cag on cag.id = ca.agency_id;

comment on view app.object_terms_v is
  'Инварианты 37 и 38. Договор объекта так, как его вправе видеть агент ЛЮБОГО агентства, и аттестация ведущего агента. Ни стартовой цены, ни долей, ни правила комиссии, ни номера сертификата.';

grant select on app.object_terms_v to authenticated;

comment on view certificate_queue_v is
  'Инвариант 38. Заявленные аттестации: что сверять. Видна администратору — политика на agents чужие агентства не показывает, и это представление её не обходит.';

grant select on certificate_queue_v to authenticated;
revoke all on certificate_queue_v from anon;
