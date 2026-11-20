-- 0009_showings.sql
-- ИНВАРИАНТ 8: показ существует только внутри подбора.
--
-- До этой миграции показ был двумя статусами подбора (showing_scheduled,
-- showing_done), одной датой matches.showing_at и видом активности
-- activity_kind = 'showing'. То есть истории показов не было: второй показ
-- затирал первый, результат фиксировался свободным текстом в заметке автора,
-- а статус подбора можно было поставить руками, не проводя показ.
--
-- Показ это то, чем агент живёт каждый день, и то, из чего собирается отчёт
-- собственнику: сколько раз объект показали, кому и с какой реакцией.
-- Поэтому у показа своя таблица, свои поля и свой инвариант:
--
--   — показ невозможен без подбора (ссылка NOT NULL и проверка в триггере);
--   — показ проводит только агент, причастный к подбору;
--   — состоявшийся показ двигает подбор в showing_done, а потребность
--     в in_showings — статусы перестают быть ручными;
--   — matches.showing_at перестаёт быть источником правды и считается
--     из таблицы показов, чтобы правда не жила в двух местах.
--
-- activities остаются тем, чем были: заметки, звонки, задачи. Вид
-- activity_kind = 'showing' больше не нужен, но не удаляется: историю
-- переносить нечего, а ломать enum ради чистоты дороже.

-- ---------------------------------------------------------------------------
-- Состояния показа
-- ---------------------------------------------------------------------------

create type showing_status as enum ('scheduled', 'done', 'cancelled', 'no_show');

-- Реакция клиента в структурированном виде. Свободный текст рядом тоже есть,
-- но отчёт собственнику и аналитика отвала строятся на этом поле.
create type showing_outcome as enum
  ('interested', 'wants_bargain', 'thinking', 'rejected');

-- ---------------------------------------------------------------------------
-- Показ
-- ---------------------------------------------------------------------------

create table showings (
  id              uuid primary key default gen_random_uuid(),

  -- ИНВАРИАНТ 8 на уровне схемы: показа вне подбора не существует.
  match_id        uuid not null references matches (id) on delete cascade,

  -- Кто проводит. Не обязательно автор записи: показ может назначить админ.
  agent_id        uuid not null references agents (id) on delete restrict,

  scheduled_at    timestamptz not null,
  done_at         timestamptz,
  status          showing_status not null default 'scheduled',

  outcome         showing_outcome,
  -- Со слов клиента, на месте встречи. Здесь легко окажется телефон,
  -- поэтому строка закрыта политикой на участников подбора.
  client_reaction text,
  note            text,
  photos          text[] not null default '{}',
  cancel_reason   text,

  created_by_agent_id uuid not null references agents (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Состоявшийся показ обязан иметь время и результат: иначе отчёт
  -- собственнику состоит из слова «показали».
  check (status <> 'done' or done_at is not null),
  check (status <> 'done' or outcome is not null),
  -- Отмена обязана иметь причину, как и отказ в подборе.
  check (status <> 'cancelled' or length(btrim(coalesce(cancel_reason, ''))) > 0)
);

comment on table showings is
  'Инвариант 8. Показ только внутри подбора. matches.showing_at считается отсюда, руками не ставится.';
comment on column showings.outcome is
  'Структурированная реакция клиента. Обязательна у состоявшегося показа.';
comment on column showings.client_reaction is
  'Свободный текст со слов клиента. Виден участникам подбора, не всей команде.';

create index showings_match_idx    on showings (match_id, scheduled_at desc);
create index showings_agent_idx    on showings (agent_id, scheduled_at desc);
create index showings_upcoming_idx on showings (scheduled_at)
  where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- Кто причастен к подбору
-- ---------------------------------------------------------------------------
-- Три роли: кто ведёт клиента (closing), кто создал подбор, и listing-агент
-- действующего мандата на объект. Последний нужен, потому что именно он
-- отвечает перед собственником за то, сколько раз объект показали.

create or replace function app.is_match_participant(p_match_id uuid, p_agent_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (
    select 1
      from matches m
      left join mandates md
             on md.object_id = m.object_id
            and md.status = 'active'
     where m.id = p_match_id
       and p_agent_id in (m.closing_agent_id, m.created_by_agent_id, md.listing_agent_id)
  )
$$;

comment on function app.is_match_participant is
  'Агент подбора: closing, автор подбора или listing-агент активного мандата объекта.';

create or replace function app.can_see_showing(p_match_id uuid) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select app.is_admin()
      or app.is_match_participant(p_match_id, app.current_agent_id())
$$;

comment on function app.can_see_showing is
  'Показ это совместная работа двух агентов, поэтому видят оба участника, а не только автор, как у activities. Свободный текст реакции открыт им обоим сознательно.';

-- ---------------------------------------------------------------------------
-- Инвариант 8: проверка перед записью
-- ---------------------------------------------------------------------------

create or replace function app.check_showing_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m   matches%rowtype;
  req requirements%rowtype;
begin
  -- BEFORE-триггер срабатывает раньше NOT NULL, поэтому отсутствие подбора
  -- надо назвать здесь, иначе наружу уйдёт невнятное сообщение драйвера.
  if new.match_id is null then
    raise exception 'INVARIANT_8: показ без подбора невозможен'
      using errcode = 'not_null_violation';
  end if;

  -- Подбор нельзя переставить на другой: иначе история показов объекта
  -- переписывается задним числом.
  if tg_op = 'UPDATE' and new.match_id <> old.match_id then
    raise exception 'INVARIANT_8: подбор показа менять нельзя'
      using errcode = 'check_violation';
  end if;

  select * into m from matches where id = new.match_id;
  if not found then
    raise exception 'INVARIANT_8: показ ссылается на несуществующий подбор %', new.match_id
      using errcode = 'foreign_key_violation';
  end if;

  if m.status = 'rejected' then
    raise exception 'INVARIANT_8: подбор отклонён, показ невозможен'
      using errcode = 'check_violation',
            hint = 'Создайте новый подбор, если клиент вернулся к объекту.';
  end if;

  select * into req from requirements where id = m.requirement_id;
  if req.status in ('closed', 'lost') then
    raise exception 'INVARIANT_8: потребность закрыта, показ невозможен'
      using errcode = 'check_violation';
  end if;

  -- Показ проводит участник подбора, а не любой одобренный агент: иначе
  -- через showings.client_reaction утекал бы контакт чужого клиента.
  if not app.is_match_participant(new.match_id, new.agent_id) then
    raise exception
      'INVARIANT_8: агент % не участвует в подборе %, показ назначить нельзя',
      new.agent_id, new.match_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger b_showing_match
  before insert or update on showings
  for each row execute function app.check_showing_match();

-- ---------------------------------------------------------------------------
-- Инвариант 8: показ двигает подбор и потребность
-- ---------------------------------------------------------------------------
-- Статусы подбора showing_scheduled и showing_done перестают быть ручными:
-- их ставит факт показа. Поэтому и matches.showing_at считается здесь.

create or replace function app.sync_match_from_showings() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_match_id uuid := coalesce(new.match_id, old.match_id);
  m          matches%rowtype;
  v_done     boolean;
  v_sched    boolean;
  v_status   match_status;
  v_at       timestamptz;
begin
  select * into m from matches where id = v_match_id;
  if not found then
    return null;
  end if;

  select
    count(*) filter (where s.status = 'done')      > 0,
    count(*) filter (where s.status = 'scheduled') > 0,
    coalesce(
      min(s.scheduled_at) filter (where s.status = 'scheduled' and s.scheduled_at >= now()),
      max(s.scheduled_at) filter (where s.status in ('scheduled', 'done')))
  into v_done, v_sched, v_at
  from showings s
  where s.match_id = v_match_id;

  -- Сделка и отказ сильнее показа: из них показ подбор не вытаскивает.
  v_status := m.status;
  if m.status not in ('in_deal', 'rejected') then
    if v_done then
      v_status := 'showing_done';
    elsif v_sched then
      if m.status in ('proposed', 'interested') then
        v_status := 'showing_scheduled';
      end if;
    elsif m.status = 'showing_scheduled' then
      -- Показ отменён или клиент не пришёл, а состоявшихся нет. Оставить
      -- showing_scheduled нельзя: подбор врал бы о назначенном показе.
      -- Возврат в interested, а не в proposed: показ однажды согласовали,
      -- значит интерес клиент выразил.
      v_status := 'interested';
    end if;
  end if;

  if v_status is distinct from m.status or v_at is distinct from m.showing_at then
    update matches set status = v_status, showing_at = v_at where id = v_match_id;
  end if;

  -- Потребность в показах: статус есть в модели с самого начала, но до
  -- появления таблицы показов его было нечем заполнять.
  if v_done then
    update requirements
       set status = 'in_showings'
     where id = m.requirement_id
       and status in ('new', 'qualified');
  end if;

  return null;
end $$;

create trigger e_showing_syncs_match
  after insert or update or delete on showings
  for each row execute function app.sync_match_from_showings();

-- ---------------------------------------------------------------------------
-- Журнал и updated_at (инвариант 7)
-- ---------------------------------------------------------------------------

create trigger a_touch_showings
  before update on showings
  for each row execute function app.touch_updated_at();

create trigger zz_audit_showings
  after insert or update or delete on showings
  for each row execute function app.write_audit('showing', 'id');

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------

alter table showings enable row level security;

create policy showings_read on showings for select
  using (app.can_see_showing(match_id));

create policy showings_insert on showings for insert
  with check (
    (created_by_agent_id = app.current_agent_id()
     and app.is_match_participant(match_id, app.current_agent_id()))
    or app.is_admin());

create policy showings_update on showings for update
  using (app.can_see_showing(match_id))
  with check (app.can_see_showing(match_id));

create policy showings_delete on showings for delete
  using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function schedule_showing(
  p_match_id uuid,
  p_at       timestamptz,
  p_note     text default null
) returns showings
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       showings;
begin
  if p_at is null then
    raise exception 'время показа обязательно' using errcode = 'not_null_violation';
  end if;

  insert into showings (match_id, agent_id, scheduled_at, note, created_by_agent_id)
  values (p_match_id, v_agent, p_at, p_note, v_agent)
  returning * into r;

  return r;
end $$;

comment on function schedule_showing is
  'Назначить показ. Проводящий агент это текущий агент: передать чужого нельзя.';

create or replace function complete_showing(
  p_showing_id      uuid,
  p_outcome         showing_outcome,
  p_client_reaction text default null,
  p_note            text default null
) returns showings
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s showings%rowtype;
  r showings;
begin
  perform app.require_agent();

  select * into s from showings where id = p_showing_id;
  if not found then
    raise exception 'показ % не найден', p_showing_id using errcode = 'no_data_found';
  end if;

  if s.status <> 'scheduled' then
    raise exception 'показ уже в состоянии %, завершить нельзя', s.status
      using errcode = 'check_violation';
  end if;

  if p_outcome is null then
    raise exception 'INVARIANT_8: у состоявшегося показа обязателен результат'
      using errcode = 'not_null_violation';
  end if;

  update showings
     set status          = 'done',
         done_at         = now(),
         outcome         = p_outcome,
         client_reaction = coalesce(p_client_reaction, client_reaction),
         note            = coalesce(p_note, note)
   where id = p_showing_id
  returning * into r;

  return r;
end $$;

comment on function complete_showing is
  'Завершить показ с результатом. Двигает подбор в showing_done, потребность в in_showings.';

create or replace function cancel_showing(
  p_showing_id uuid,
  p_reason     text
) returns showings
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r showings;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'причина отмены обязательна' using errcode = 'check_violation';
  end if;

  update showings
     set status = 'cancelled', cancel_reason = p_reason
   where id = p_showing_id and status = 'scheduled'
  returning * into r;

  if r.id is null then
    raise exception 'показ % не найден или уже не назначен', p_showing_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Данные для кабинета
-- ---------------------------------------------------------------------------
-- Контакт присоединён через LEFT JOIN: агент, которому контакт не положен,
-- видит показ с пустым именем клиента, а не теряет строку целиком.

create or replace view showings_v
  with (security_invoker = true) as
select
  s.id,
  s.match_id,
  s.status,
  s.scheduled_at,
  s.done_at,
  s.outcome,
  s.client_reaction,
  s.agent_id,
  ag.full_name          as agent_name,
  o.id                  as object_id,
  o.address,
  o.zone,
  o.deal_type,
  o.price,
  o.currency,
  r.id                  as requirement_id,
  c.name                as client_name,
  md.listing_agent_id
from showings s
join matches      m  on m.id  = s.match_id
join objects      o  on o.id  = m.object_id
join requirements r  on r.id  = m.requirement_id
left join agents  ag on ag.id = s.agent_id
left join contacts c on c.id  = r.contact_id
left join mandates md on md.object_id = m.object_id and md.status = 'active';

comment on view showings_v is
  'Показы для кабинета. Контакт через LEFT JOIN: инвариант 4 скрывает имя, но не строку.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on showings to authenticated;
grant select on showings_v to authenticated;
revoke all on showings, showings_v from anon;

grant execute on function
  app.is_match_participant(uuid, uuid),
  app.can_see_showing(uuid),
  schedule_showing(uuid, timestamptz, text),
  complete_showing(uuid, showing_outcome, text, text),
  cancel_showing(uuid, text)
  to authenticated;
