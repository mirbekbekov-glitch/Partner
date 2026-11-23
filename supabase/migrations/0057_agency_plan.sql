-- 0057_agency_plan.sql
-- Тариф агентства. Решение владельца продукта: один агент — бесплатно,
-- команда и площадки — за деньги. Пункт 2 раздела 7 спецификации.
--
-- ЧТО БЕСПЛАТНО. Объекты и клиенты — без ограничений. Это не щедрость, а
-- механика: объекты наполняют НАШ каталог, и лимит на них был бы выстрелом в
-- собственную ногу. Спецификация говорит это прямым текстом: «лимиты объектов
-- означали бы, что агент не заводит объекты в каталог. Пустой каталог убивает
-- платформу». Бесплатному агенту доступен весь кабинет: договоры, подбор,
-- показы, сделки, подборки, кабинет собственника, наш каталог.
--
-- ЧТО ЗА ДЕНЬГИ. Ровно то, что выводит за пределы одиночной работы:
--
--   1. ВТОРОЙ АГЕНТ в агентстве. Бесплатный тариф — для одиночки, и слово
--      «одиночка» здесь не метафора: на нём в агентстве один человек;
--   2. ВЫГРУЗКА НА ПЛОЩАДКИ — lalafo, house.kg. Наш каталог и наши
--      поверхности остаются бесплатными: за них платим мы, и они работают
--      на нас. За чужую витрину платит тот, кто ею пользуется.
--
-- ПОЧЕМУ ИМЕННО ТАК, А НЕ «10 ОБЪЕКТОВ, 30 КЛИЕНТОВ» КАК У HomeCRM. Эти два
-- пункта спецификации противоречили друг другу: пункт 1 раздела 5 запрещает
-- лимиты на размер базы, пункт 2 приводит в пример тариф, который состоит из
-- них. Выбран первый: лимит на базу заставляет агента решать, какой объект
-- заводить, а какой нет, и проигрывает ровно там, где платформа выигрывает.

alter table agencies add column plan text not null default 'solo';

alter table agencies add constraint agencies_plan_known
  check (plan in ('solo', 'team'));

comment on column agencies.plan is
  'Тариф агентства. solo — один агент, без выгрузки на внешние площадки; team — без этих ограничений. Объекты и клиенты не ограничены ни на одном.';

-- Никого не понижаем ниже того, чем он уже пользуется: у кого больше одного
-- агента — тому team. Иначе включение инварианта сделало бы существующие
-- агентства недействительными задним числом.
update agencies ag
   set plan = 'team'
 where (select count(*) from agents a where a.agency_id = ag.id) > 1;

-- Liberterra — НАШЕ агентство, и тариф ему назначается прямо, а не выводится
-- подсчётом. На чистой базе агентов в нём ещё нет, подсчёт дал бы solo, и
-- первый же засев падал бы на инварианте мест. Это не частный случай ради
-- тестов: в бою Liberterra заводится миграцией 0042 раньше всех людей.
update agencies set plan = 'team'
 where id = '00000000-0000-0000-0000-00000000aa01';

-- ---------------------------------------------------------------------------
-- Что считать площадкой
-- ---------------------------------------------------------------------------
-- Данные, а не список в коде: площадки добавляются строкой в channel_feeds, и
-- новая не должна требовать правки триггера. У нашего каталога (site) строки
-- фида нет вовсе — он не выгрузка, он мы.

alter table channel_feeds add column external boolean not null default true;

update channel_feeds set external = false where channel = 'mini_app';

comment on column channel_feeds.external is
  'Канал ведёт на ЧУЖУЮ витрину. За неё платит тот, кто ею пользуется: на бесплатном тарифе такие каналы не включаются. Наши поверхности — false.';

create or replace function app.channel_is_external(p_channel publication_channel)
  returns boolean language sql stable security definer
  set search_path = public, pg_temp as $$
  select coalesce((select f.external from channel_feeds f where f.channel = p_channel), false)
$$;

comment on function app.channel_is_external is
  'Ведёт ли канал на чужую витрину. Без строки в channel_feeds канал наш: у site фида нет, он и есть наш каталог.';

revoke execute on function app.channel_is_external(publication_channel) from public;
grant execute on function app.channel_is_external(publication_channel) to authenticated;

-- ---------------------------------------------------------------------------
-- Инвариант 39: на бесплатном тарифе агентство одно-единственное лицо
-- ---------------------------------------------------------------------------
-- Проверка в базе, а не на экране. Второго агента заводят тремя путями: вход
-- по почте, перевод из другого агентства и правка администратором. Держать
-- правило на одном из них значит не держать его вовсе.
--
-- Заблокированный не считается: блокировка — это и есть способ освободить
-- место. Ожидающий считается: он уже занял место и ждёт одобрения, а не
-- оплаты.

create or replace function app.check_agency_seats() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_plan  text;
  v_count integer;
begin
  if new.status = 'blocked' then
    return new;
  end if;

  select ag.plan into v_plan from agencies ag where ag.id = new.agency_id;
  if v_plan is distinct from 'solo' then
    return new;
  end if;

  select count(*) into v_count
    from agents a
   where a.agency_id = new.agency_id
     and a.status <> 'blocked'
     and a.id <> new.id;

  if v_count > 0 then
    raise exception
      'INVARIANT_39: на бесплатном тарифе в агентстве один агент; чтобы работать командой, нужен тариф «команда»'
      using errcode = 'check_violation',
            hint = 'Смените тариф агентства или заблокируйте прежнего агента.';
  end if;

  return new;
end $$;

comment on function app.check_agency_seats is
  'Инвариант 39. На тарифе solo в агентстве не больше одного незаблокированного агента.';

revoke execute on function app.check_agency_seats() from public;

create trigger c_agency_seats
  before insert or update of agency_id, status on agents
  for each row execute function app.check_agency_seats();

-- Тариф нельзя понизить до solo, пока в агентстве больше одного человека:
-- иначе правило обходится со стороны агентства, а не агента.
create or replace function app.check_agency_plan_downgrade() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if new.plan <> 'solo' or old.plan = 'solo' then
    return new;
  end if;

  select count(*) into v_count
    from agents a where a.agency_id = new.id and a.status <> 'blocked';

  if v_count > 1 then
    raise exception
      'INVARIANT_39: в агентстве % человек, на бесплатный тариф оно не переводится', v_count
      using errcode = 'check_violation',
            hint = 'Сначала останется один агент, потом тариф.';
  end if;

  return new;
end $$;

comment on function app.check_agency_plan_downgrade is
  'Инвариант 39. Понижение тарифа до solo невозможно, пока в агентстве больше одного человека: правило не должно обходиться со стороны агентства.';

revoke execute on function app.check_agency_plan_downgrade() from public;

create trigger c_agency_plan_downgrade
  before update of plan on agencies
  for each row execute function app.check_agency_plan_downgrade();

-- ---------------------------------------------------------------------------
-- Инвариант 39: площадки — за деньги
-- ---------------------------------------------------------------------------
-- Тело взято из базы дословно, добавлена одна проверка перед возвратом.

CREATE OR REPLACE FUNCTION app.check_channel_publication()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Включить канал можно только объекту с действующим договором. Это
  -- проверка намерения, а не членства: держать включённым канал объекта,
  -- у которого договор истёк, не вредно — в фид он всё равно не попадёт, —
  -- но ВКЛЮЧАТЬ его в таком состоянии бессмысленно и запутывает.
  if new.enabled and app.active_mandate_id(new.object_id) is null then
    raise exception
      'INVARIANT_1: объект % не может быть выгружен в канал % без активного мандата',
      new.object_id, new.channel
      using errcode = 'check_violation';
  end if;
  -- Площадка — за деньги. Наш каталог и наши поверхности остаются
  -- бесплатными: за них платим мы, и работают они на нас. За чужую витрину
  -- платит тот, кто ею пользуется.
  --
  -- Агентство берётся у listing-агента действующего договора: объект ведёт
  -- он, и тариф спрашивается с того, кто ведёт.
  if new.enabled and app.channel_is_external(new.channel) then
    if exists (
      select 1
        from mandates m
        join agents a   on a.id = m.listing_agent_id
        join agencies ag on ag.id = a.agency_id
       where m.object_id = new.object_id and m.status = 'active'
         and ag.plan = 'solo'
    ) then
      raise exception
        'INVARIANT_39: выгрузка на площадку % — на тарифе «команда»', new.channel
        using errcode = 'check_violation',
              hint = 'Наш каталог остаётся бесплатным; за чужую витрину платит тот, кто ею пользуется.';
    end if;
  end if;

  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- Вход заводит одиночке своё агентство
-- ---------------------------------------------------------------------------
-- Тело взято из базы дословно, добавлен блок перед вставкой агента.
--
-- Статус остаётся «ожидает»: одобрение администратором не отменяется. Это
-- сознательно и это НЕ про деньги. Одобренный агент видит мультилистинг —
-- кто каким объектом владеет и на каких условиях, — и впускать туда любого,
-- кто подтвердил почту, значит отдавать главную ценность платформы даром.
-- Бесплатный тариф отвечает на вопрос «сколько платить», а не «кого пускать».

CREATE OR REPLACE FUNCTION app.login_by_email(p_full_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS agents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_email  text := app.current_email();
  v_uid    uuid := auth.uid();
  r        agents;
  v_agency uuid;
  v_name   text;
begin
  if v_email is null then
    raise exception 'INVARIANT_6: во входе нет подтверждённого адреса почты'
      using errcode = '42501',
            hint = 'Сначала подтвердите адрес кодом, затем вызывайте вход.';
  end if;

  -- НОВЫЙ человек получает СВОЁ агентство, а не попадает в наше.
  --
  -- Раньше agency_id брался из умолчания колонки — а оно со времён миграции
  -- 0042 указывает на Liberterra, потому что тогда агентство было одно. Со
  -- входом по почте это значило, что всякий зарегистрировавшийся становится
  -- (пока ожидающим) членом НАШЕГО агентства, и одобрение администратором
  -- впускало его внутрь — к видимости чужих клиентов и сделок по инварианту 33.
  --
  -- Теперь одиночка заводит себе агентство на тарифе solo и становится в нём
  -- руководителем: он в нём один, и спрашивать разрешения не у кого.
  if not exists (select 1 from agents a where a.email = v_email) then
    v_name := coalesce(nullif(btrim(p_full_name), ''), split_part(v_email, '@', 1));

    -- Имя агентства уникально. Тёзки бывают, и отказывать второму Нурлану во
    -- входе из-за первого нельзя: к имени добавляется различитель.
    if exists (select 1 from agencies ag where lower(btrim(ag.name)) = lower(btrim(v_name))) then
      v_name := v_name || ' (' || split_part(v_email, '@', 1) || ')';
    end if;
    if exists (select 1 from agencies ag where lower(btrim(ag.name)) = lower(btrim(v_name))) then
      v_name := v_name || ' ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into agencies (name, plan) values (v_name, 'solo')
    returning id into v_agency;
  end if;

  insert into agents (email, phone, full_name, auth_user_id, email_verified_at,
                      agency_id, role)
  values (v_email,
          nullif(btrim(coalesce(p_phone, '')), ''),
          coalesce(nullif(btrim(p_full_name), ''), v_email),
          v_uid,
          now(),
          coalesce(v_agency, '00000000-0000-0000-0000-00000000aa01'),
          (case when v_agency is null then 'agent' else 'head' end)::agent_role)
  on conflict (email) do update
     set full_name         = coalesce(nullif(btrim(p_full_name), ''), agents.full_name),
         auth_user_id      = coalesce(excluded.auth_user_id, agents.auth_user_id),
         email_verified_at = now(),
         updated_at        = now()
  returning * into r;

  return r;
end $function$;

comment on function app.login_by_email is
  'Инвариант 6. Вход по подтверждённой почте. Новому человеку заводится СВОЁ агентство на тарифе solo, и он в нём руководитель: попадать в чужое агентство по умолчанию колонки он не должен.';

-- ---------------------------------------------------------------------------
-- Тариф виден агенту
-- ---------------------------------------------------------------------------
-- Ограничение, о котором узнаёшь только отказом, воспринимается как поломка.
-- Тариф приходит в me_v рядом с именем агентства — туда же, куда кабинет уже
-- смотрит, чтобы показать, от чьего имени человек работает.

create or replace view me_v as
 SELECT a.id,
    a.full_name,
    a.email,
    a.phone,
    a.role,
    a.status,
    a.email_verified_at,
    a.phone_verified_at,
    a.telegram_id,
    a.created_at,
    a.directions,
    a.avatar_key,
    a.certificate_no,
    a.certificate_issued_on,
    a.certificate_valid_to,
    a.certificate_confirmed_at,
    app.certificate_state(a.certificate_no, a.certificate_confirmed_at, a.certificate_valid_to) AS certificate_state,
    ag.id AS agency_id,
    ag.name AS agency_name,
    app.is_admin() AS is_admin,
    app.is_head() AS is_head,
    -- Тариф агентства: колонка дописывается В КОНЕЦ, потому что
    -- `create or replace view` не умеет вставлять её в середину.
    ag.plan AS agency_plan
   FROM agents a
     JOIN agencies ag ON ag.id = a.agency_id
  WHERE a.auth_user_id = auth.uid();
