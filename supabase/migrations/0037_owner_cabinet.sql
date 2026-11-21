-- 0037_owner_cabinet.sql
-- ИНВАРИАНТ 29: у собственника есть кабинет, и в нём он распоряжается
--               доступом в свою квартиру.
--
-- Инвариант 10 дал собственнику отчёт: одна страница по одному объекту,
-- только чтение. Этого достаточно, чтобы он видел работу, и недостаточно,
-- чтобы он в ней участвовал. Две вещи, которых не хватало:
--
--   1. СОБСТВЕННИК — ЧЕЛОВЕК, А НЕ ОБЪЕКТ. Отдал агентству три квартиры —
--      получил три ссылки и не знает, какая от какой. Кабинет выдаётся
--      контакту и показывает всё, что за ним числится.
--
--   2. СОБСТВЕННИК ЖИВЁТ В КВАРТИРЕ, КОТОРУЮ ПОКАЗЫВАЮТ. Сейчас показ
--      назначается, не спрашивая его вовсе: агент выбирает время, клиент
--      приходит. Для собственника, который там живёт, это не отчёт, а
--      новость постфактум.
--
--      Полное согласование каждого показа — другая история и другой объём.
--      Здесь делается то, что закрывает худший случай и поддаётся правилу:
--      собственник может ПРИОСТАНОВИТЬ показы. Уехал, болеет, ремонт — он
--      говорит об этом сам, а не через звонок агенту, который может забыть.
--
-- ЧТО ТАКОЕ ПРИОСТАНОВКА. Состояние объекта, а не пожелание в переписке.
-- Пока она стоит: новый показ не назначить ничем, а назначенные сняты. Это
-- и отличает право от просьбы.
--
-- Снять паузу может тот, кто её поставил, и администратор. Агент не снимает
-- паузу собственника: иначе право превращается в пожелание, которое можно
-- отменить, не спросив.

-- ---------------------------------------------------------------------------
-- Приостановка показов
-- ---------------------------------------------------------------------------

create type pause_author as enum ('owner', 'agent', 'admin');

alter table objects add column showings_paused_at    timestamptz;
alter table objects add column showings_pause_reason text;
alter table objects add column showings_paused_by    pause_author;

alter table objects add constraint objects_pause_has_author
  check ((showings_paused_at is null) = (showings_paused_by is null));

comment on column objects.showings_paused_at is
  'Инвариант 29. Показы по объекту приостановлены. Пока стоит — новых показов нет, назначенные сняты.';
comment on column objects.showings_paused_by is
  'Кто приостановил. Снять может он же или администратор: иначе право собственника превращается в пожелание.';

create or replace function app.showings_paused(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from objects o
                  where o.id = p_object_id and o.showings_paused_at is not null)
$$;

comment on function app.showings_paused is
  'Инвариант 29. Показы по объекту приостановлены собственником или агентом.';

-- ---------------------------------------------------------------------------
-- Инвариант 29: пауза снимает назначенные показы
-- ---------------------------------------------------------------------------
-- Последствие в триггере причины, а не в функции: паузу ставят из кабинета
-- собственника, из кабинета агента и прямой правкой, и правило обязано
-- держаться на всех путях. Урок инвариантов 21, 24, 25 и 27.
--
-- Уведомления при этом гаснут и уходят поправкой сами (инвариант 27): он
-- слушает показы, а не причину их отмены.

create or replace function app.cancel_showings_on_pause() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.showings_paused_at is not null and old.showings_paused_at is null then
    update showings s
       set status = 'cancelled',
           cancel_reason = 'показы по объекту приостановлены: ' ||
                           coalesce(nullif(btrim(new.showings_pause_reason), ''),
                                    'без объяснения')
      from matches m
     where m.id = s.match_id
       and m.object_id = new.id
       and s.status = 'scheduled';
  end if;
  return null;
end $$;

create trigger zy_pause_cancels_showings
  after update of showings_paused_at on objects
  for each row execute function app.cancel_showings_on_pause();

-- ---------------------------------------------------------------------------
-- Инвариант 29: на приостановленный объект показ не назначается
-- ---------------------------------------------------------------------------
-- Проверка добавляется в тот же триггер, где живут остальные правила показа
-- (инварианты 8, 25, 26): правила показа в одном месте, а не россыпью.

create or replace function app.check_showing_paused() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_object uuid;
  v_reason text;
  v_by     pause_author;
begin
  if new.status <> 'scheduled' then
    return new;
  end if;

  select o.id, o.showings_pause_reason, o.showings_paused_by
    into v_object, v_reason, v_by
    from matches m
    join objects o on o.id = m.object_id
   where m.id = new.match_id
     and o.showings_paused_at is not null;

  if v_object is null then
    return new;
  end if;

  raise exception
    'INVARIANT_29: показы по объекту приостановлены (%): %',
    case v_by when 'owner' then 'собственником' else 'агентством' end,
    coalesce(nullif(btrim(v_reason), ''), 'без объяснения')
    using errcode = 'check_violation',
          hint = 'Снять приостановку может тот, кто её поставил, или администратор.';
end $$;

create trigger c_showing_not_paused
  before insert or update on showings
  for each row execute function app.check_showing_paused();

-- ---------------------------------------------------------------------------
-- Приостановка — не правка объекта
-- ---------------------------------------------------------------------------
-- Инвариант 22 говорит: объект правит listing-агент действующего договора.
-- Собственник таким агентом не является и быть не должен — но приостановка
-- показов это НЕ правка объекта: он не меняет ни цену, ни адрес, ни
-- публикацию, он закрывает дверь в собственную квартиру.
--
-- Без этой оговорки право собственника держалось бы на случайности: оно
-- работало бы только потому, что у анонима нет клейма агента, и ломалось бы
-- в ту секунду, когда функцию вызовут из сессии вошедшего человека. Правило,
-- которое работает по совпадению, — не правило.

create or replace function app.check_object_editor() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  -- Приостановка и возобновление показов: кто имеет на это право, решает
  -- инвариант 29 в app.set_pause(), а не правило о правке объекта.
  if new.showings_paused_at is distinct from old.showings_paused_at
     and new.price            is not distinct from old.price
     and new.address          is not distinct from old.address
     and new.publication_state is not distinct from old.publication_state then
    return new;
  end if;

  -- Правило касается запросов от вошедшего человека. Плановые работы,
  -- миграции и перенос идут без входа и правило не нарушают.
  if auth.uid() is null or app.is_admin() then
    return new;
  end if;

  if app.is_listing_agent(new.id) then
    return new;
  end if;

  -- Дальше — случаи, когда действующего договора у объекта нет вовсе.
  if not exists (select 1 from mandates m
                  where m.object_id = new.id and m.status = 'active') then

    -- Снятие с публикации вслед за закрытым или истёкшим договором. Это не
    -- правка, а требование инварианта 1, и выполняет его тот, кто закрыл
    -- сделку, — а он чаще всего агент покупателя, а не владелец мандата.
    if new.publication_state is distinct from old.publication_state
       and new.publication_state <> 'published' then
      return new;
    end if;

    -- Прочее по объекту без договора правит тот, кто его завёл: иначе объект
    -- с истёкшим мандатом становится неисправимым, и даже заключить новый
    -- договор по нему будет нельзя.
    if new.created_by_agent_id = app.current_agent_id() then
      return new;
    end if;
  end if;

  raise exception
    'INVARIANT_22: объект ведёт агент действующего договора'
    using errcode = '42501',
          hint = 'Правит объект тот, кто отвечает за него перед собственником.';
end $$;

comment on function app.check_object_editor is
  'Инвариант 22. Правит объект listing-агент действующего договора; объект без договора — тот, кто его завёл. Приостановка показов правкой не считается: это право собственника (инвариант 29).';

-- ---------------------------------------------------------------------------
-- Кто ставит и снимает
-- ---------------------------------------------------------------------------

create or replace function app.set_pause(
  p_object_id uuid,
  p_paused    boolean,
  p_reason    text,
  p_author    pause_author
) returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o objects%rowtype;
  r objects;
begin
  select * into o from objects where id = p_object_id;
  if not found then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  if p_paused then
    if o.showings_paused_at is not null then
      return o;  -- уже приостановлены, повторная просьба ничего не меняет
    end if;
    if length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'INVARIANT_29: у приостановки показов обязательна причина'
        using errcode = 'check_violation',
              hint = 'Агенту надо знать, что отвечать клиентам.';
    end if;

    update objects
       set showings_paused_at = now(),
           showings_pause_reason = p_reason,
           showings_paused_by = p_author
     where id = p_object_id
    returning * into r;
    return r;
  end if;

  if o.showings_paused_at is null then
    return o;
  end if;

  -- Снимает тот, кто поставил, или администратор. Агент не снимает паузу
  -- собственника: иначе право превращается в пожелание.
  if o.showings_paused_by = 'owner' and p_author <> 'owner' and p_author <> 'admin' then
    raise exception
      'INVARIANT_29: показы приостановил собственник, снять может он или администратор'
      using errcode = '42501';
  end if;

  update objects
     set showings_paused_at = null,
         showings_pause_reason = null,
         showings_paused_by = null
   where id = p_object_id
  returning * into r;
  return r;
end $$;

comment on function app.set_pause is
  'Инвариант 29. Ставит и снимает приостановку. Кто именно — передаёт вызывающий: у собственника свой путь, у агента свой, а правило снятия одно.';

create or replace function pause_showings(p_object_id uuid, p_reason text)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_agent();
  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_29: приостанавливает показы агент действующего договора'
      using errcode = '42501';
  end if;
  return app.set_pause(p_object_id, true, p_reason,
                       case when app.is_admin() then 'admin' else 'agent' end::pause_author);
end $$;

create or replace function resume_showings(p_object_id uuid)
  returns objects
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_agent();
  if not app.is_listing_agent(p_object_id) and not app.is_admin() then
    raise exception 'INVARIANT_29: возобновляет показы агент действующего договора'
      using errcode = '42501';
  end if;
  return app.set_pause(p_object_id, false, null,
                       case when app.is_admin() then 'admin' else 'agent' end::pause_author);
end $$;

comment on function pause_showings is
  'Инвариант 29. Агент приостанавливает показы по своему объекту. Паузу собственника он снять не может.';

-- ---------------------------------------------------------------------------
-- Доступ в кабинет: по контакту, а не по объекту
-- ---------------------------------------------------------------------------
-- object_id становится необязательным. NULL означает «кабинет»: доступ ко
-- всем объектам этого контакта, где он собственник и есть договор. Ссылки на
-- отдельный объект продолжают работать как работали — инвариант 10 не
-- отменяется, он дополняется.

alter table owner_access alter column object_id drop not null;

comment on column owner_access.object_id is
  'Объект, по которому выдана ссылка. NULL — ссылка на кабинет: все объекты этого контакта (инвариант 29).';

create unique index owner_access_cabinet_idx
  on owner_access (contact_id)
  where object_id is null and revoked_at is null;

comment on index owner_access_cabinet_idx is
  'Один действующий кабинет на собственника: иначе отозвать доступ значило бы искать все выданные ссылки.';

create or replace function app.check_owner_access() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_listing uuid;
begin
  -- Кабинет: контакт обязан быть собственником хотя бы одного объекта с
  -- действующим договором, а выдать кабинет может агент любого из них.
  if new.object_id is null then
    if not exists (
      select 1 from object_ownerships oo
       join mandates m on m.object_id = oo.object_id and m.status = 'active'
      where oo.contact_id = new.contact_id
        and oo.role in ('owner', 'co_owner', 'proxy')
        and (m.listing_agent_id = new.issued_by_agent_id or app.is_admin())
    ) then
      raise exception
        'INVARIANT_29: кабинет выдаётся собственнику объекта с действующим договором, и выдаёт его агент этого договора'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Токен выдаётся собственнику ЭТОГО объекта, а не любому контакту.
  if not exists (
    select 1 from object_ownerships oo
     where oo.object_id = new.object_id
       and oo.contact_id = new.contact_id
       and oo.role in ('owner', 'co_owner', 'proxy')
  ) then
    raise exception
      'INVARIANT_10: контакт % не числится собственником объекта %',
      new.contact_id, new.object_id
      using errcode = 'check_violation';
  end if;

  select m.listing_agent_id into v_listing
    from mandates m
   where m.object_id = new.object_id and m.status = 'active';

  if v_listing is null then
    raise exception
      'INVARIANT_10: на объекте % нет активного мандата, отчёт выдавать не о чем',
      new.object_id using errcode = 'check_violation';
  end if;

  if new.issued_by_agent_id <> v_listing and not app.is_admin() then
    raise exception
      'INVARIANT_10: ссылку выдаёт listing-агент мандата (%), а не любой агент',
      v_listing using errcode = 'check_violation';
  end if;

  return new;
end $$;

create or replace function issue_owner_cabinet(
  p_contact_id uuid,
  p_days       integer default 365
) returns owner_access
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       owner_access;
begin
  select * into r from owner_access
   where contact_id = p_contact_id and object_id is null and revoked_at is null;

  if found then
    update owner_access
       set expires_at = case when p_days is null then null
                             else now() + make_interval(days => p_days) end
     where id = r.id
    returning * into r;
    return r;
  end if;

  insert into owner_access (object_id, contact_id, token, issued_by_agent_id, expires_at)
  values (null, p_contact_id,
          replace(gen_random_uuid()::text, '-', ''),
          v_agent,
          case when p_days is null then null
               else now() + make_interval(days => p_days) end)
  returning * into r;

  return r;
end $$;

comment on function issue_owner_cabinet is
  'Инвариант 29. Ссылка на кабинет собственника: все его объекты сразу. Повторный вызов продлевает существующую, а не плодит вторую.';

-- ---------------------------------------------------------------------------
-- Что видит собственник
-- ---------------------------------------------------------------------------
-- Те же правила, что в отчёте (инвариант 10): ни комиссии, ни имён клиентов,
-- ни свободного текста с показов. Добавляются две вещи, которых в отчёте не
-- было и которые собственнику нужнее всего: КОГДА к нему придут и может ли
-- он это остановить.

create or replace function app.owner_cabinet(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a      owner_access%rowtype;
  v_body jsonb;
begin
  select * into a from owner_access
   where token = p_token
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  if not found or a.object_id is not null then
    -- Ссылка на один объект кабинетом не открывается: для неё есть
    -- app.owner_report(). Один токен — одна дверь.
    return null;
  end if;

  update owner_access
     set view_count = view_count + 1, last_viewed_at = now()
   where id = a.id;

  select jsonb_build_object(
    'owner', jsonb_build_object(
      'name', c.name,
      'generated_at', now()),
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id',           o.id,
          'address',      o.address,
          'kind',         o.kind,
          'deal_type',    o.deal_type,
          'price',        o.price,
          'currency',     o.currency,
          'rooms',        o.rooms,
          'area',         o.area,
          'publication_state', o.publication_state,
          'actual_at',    o.actual_at,
          'paused',       o.showings_paused_at is not null,
          'pause_reason', o.showings_pause_reason,
          'paused_by',    o.showings_paused_by,
          -- Сколько раз показали и чем кончилось. Имён клиентов и их слов
          -- здесь нет: инвариант 4 действует и в эту сторону.
          'showings_done', (
            select count(*) from showings s
              join matches m on m.id = s.match_id
             where m.object_id = o.id and s.status = 'done'),
          -- А вот это новое и ради этого всё: КОГДА придут. Время и больше
          -- ничего — ни кто, ни с кем.
          'showings_ahead', coalesce((
            select jsonb_agg(s.scheduled_at order by s.scheduled_at)
              from showings s
              join matches m on m.id = s.match_id
             where m.object_id = o.id
               and s.status = 'scheduled'
               and s.scheduled_at > now()), '[]'::jsonb),
          'channels', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'channel', pc.channel,
                     'in_feed', pc.enabled and exists (
                                  select 1 from public_catalog_v cc where cc.id = o.id))
                   order by pc.channel)
              from publication_channels pc where pc.object_id = o.id), '[]'::jsonb))
        order by o.address)
        from object_ownerships oo
        join objects o on o.id = oo.object_id
        join mandates md on md.object_id = o.id and md.status = 'active'
       where oo.contact_id = a.contact_id
         and oo.role in ('owner', 'co_owner', 'proxy')
    ), '[]'::jsonb))
  into v_body
  from contacts c where c.id = a.contact_id;

  return v_body;
end $$;

comment on function app.owner_cabinet is
  'Инвариант 29. Кабинет собственника по токену: все его объекты с действующим договором. Имён клиентов и комиссии здесь нет — те же правила, что в отчёте.';

-- ---------------------------------------------------------------------------
-- Что собственник может сделать
-- ---------------------------------------------------------------------------

create or replace function app.owner_pause(
  p_token     text,
  p_object_id uuid,
  p_paused    boolean,
  p_reason    text default null
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare a owner_access%rowtype;
begin
  select * into a from owner_access
   where token = p_token
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'ссылка не действует');
  end if;

  -- Токен кабинета распоряжается всеми объектами контакта; токен одного
  -- объекта — только им. Чужим объектом не распорядиться ни тем, ни другим.
  if not exists (
    select 1 from object_ownerships oo
     where oo.contact_id = a.contact_id
       and oo.object_id = p_object_id
       and oo.role in ('owner', 'co_owner', 'proxy')
       and (a.object_id is null or a.object_id = p_object_id)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'это не ваш объект');
  end if;

  if p_paused and length(btrim(coalesce(p_reason, ''))) = 0 then
    return jsonb_build_object('ok', false,
      'reason', 'напишите причину: агенту надо знать, что отвечать клиентам');
  end if;

  perform app.set_pause(p_object_id, p_paused, p_reason, 'owner');
  return jsonb_build_object('ok', true);
exception
  -- Отказ правила — это ответ собственнику, а не пятисотая страница.
  when sqlstate '42501' or sqlstate '23514' then
    return jsonb_build_object('ok', false, 'reason', sqlerrm);
end $$;

comment on function app.owner_pause is
  'Инвариант 29. Собственник приостанавливает и возобновляет показы по своему объекту. Отказ возвращается ответом: страница ошибки собственнику ничего не объясняет.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.showings_paused(uuid),
  app.cancel_showings_on_pause(),
  app.check_showing_paused(),
  app.set_pause(uuid, boolean, text, pause_author),
  pause_showings(uuid, text),
  resume_showings(uuid),
  issue_owner_cabinet(uuid, integer),
  app.owner_cabinet(text),
  app.owner_pause(text, uuid, boolean, text)
  from public;

grant execute on function
  app.showings_paused(uuid),
  pause_showings(uuid, text),
  resume_showings(uuid),
  issue_owner_cabinet(uuid, integer)
  to authenticated;

-- Кабинет собственника открывается анониму по токену — как и отчёт.
grant execute on function
  app.owner_cabinet(text),
  app.owner_pause(text, uuid, boolean, text)
  to anon;
