-- 0038_funnel.sql
-- ИНВАРИАНТ 30: воронка — это следствие работы, а не поле, которое
--               перетаскивают.
--
-- Канбан просят во всех CRM, и во всех CRM он устроен одинаково плохо:
-- колонка это поле, карточку таскают мышкой, поле меняется. Через месяц в
-- колонке «Сделка» стоят клиенты без сделок, в «Закрыто» — закрытые «потому
-- что надоело», и отчёт по воронке не значит ничего.
--
-- ЧТО ПОКАЗАЛИ ПРОБЫ на живой базе до начала работы:
--
--   1. Агент своей потребности ставил `in_deal` одним UPDATE. Сделки нет,
--      мандат не закрыт, комиссия не рассчитана — а воронка показывает
--      сделку.
--   2. Он же ставил `closed` с причиной «продал сам». Это сделка мимо
--      системы, и именно так её и проводят, когда не хотят платить.
--   3. Закрытую потребность он же возвращал в `new`. Исход не был
--      окончательным ничем.
--   4. `lost` не ставился НИЧЕМ: ни функции, ни пути. Клиент, который
--      передумал, оставался в воронке навсегда.
--   5. `new` → `qualified` руками тоже не ставился. То есть канбан, который
--      просят, двигать было нечем вовсе.
--
-- ПРАВИЛО. Колонка воронки проверяется фактом, а не доверием к вызывающему:
--
--   `in_showings`  — есть состоявшийся показ;
--   `in_deal`      — есть незавершённая сделка;
--   `closed`       — есть закрытая сделка;
--   `qualified`    — решение агента (разобрался, что клиент ищет), а после
--                    срыва сделки — возврат в работу;
--   `lost`         — решение агента с причиной: клиент ушёл.
--
-- Отсюда и ответ на «а как же перетащить мышкой»: карточка переезжает в
-- системную колонку сама, когда случается работа. Перетащить можно ровно
-- два перехода — те, которые и есть решение агента, а не его пожелание.

-- ---------------------------------------------------------------------------
-- Сколько карточка стоит в колонке
-- ---------------------------------------------------------------------------
-- Воронка без времени в колонке показывает количество, а спрашивают у неё
-- всегда другое: где встало. Тот же приём, что у этапов сделки (инвариант 24).

alter table requirements add column stage_since timestamptz not null default now();

comment on column requirements.stage_since is
  'Инвариант 30. Когда потребность попала в текущую колонку воронки. Выставляется триггером: дату застревания нельзя сдвинуть правкой.';

create or replace function app.touch_requirement_stage() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status then
    new.stage_since := now();
  end if;
  return new;
end $$;

-- `before update` без списка столбцов, а не `of status`: иначе правка, в
-- которой столбец status просто УПОМЯНУТ, обходила бы проверку датой. Тот же
-- приём, что у a_deal_stage_since (инвариант 24).
create trigger a_requirement_stage_since
  before update on requirements
  for each row execute function app.touch_requirement_stage();

-- ---------------------------------------------------------------------------
-- Факты, на которых стоит колонка
-- ---------------------------------------------------------------------------

create or replace function app.requirement_has_done_showing(p_requirement_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from showings s
     join matches m on m.id = s.match_id
    where m.requirement_id = p_requirement_id and s.status = 'done')
$$;

create or replace function app.requirement_has_open_deal(p_requirement_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from deals d
     where d.requirement_id = p_requirement_id
       and d.status not in ('closed', 'failed'))
$$;

create or replace function app.requirement_has_closed_deal(p_requirement_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from deals d
     where d.requirement_id = p_requirement_id and d.status = 'closed')
$$;

comment on function app.requirement_has_open_deal is
  'Инвариант 30. Факт, на котором стоит колонка «В сделке». Колонка без факта — это утверждение, которого система не знает.';

-- ---------------------------------------------------------------------------
-- Инвариант 30: переход по воронке
-- ---------------------------------------------------------------------------
-- Матрица переходов в одном месте и читается как правило, а не как россыпь
-- if-ов по функциям. Второй столбец — кто двигает: факт или человек.

create or replace function app.funnel_move_kind(
  p_old requirement_status,
  p_new requirement_status,
  p_requirement_id uuid
) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    -- Из итога возврата нет: клиент вернулся — это новая потребность, а не
    -- воскрешение старой. Иначе «проиграно» в отчёте значит «пока проиграно».
    when p_old in ('closed', 'lost') then 'нет'

    when p_new = 'in_showings' then
      case when p_old in ('new', 'qualified')
            and app.requirement_has_done_showing(p_requirement_id)
           then 'факт' else 'нет' end

    when p_new = 'in_deal' then
      case when app.requirement_has_open_deal(p_requirement_id)
           then 'факт' else 'нет' end

    when p_new = 'closed' then
      case when app.requirement_has_closed_deal(p_requirement_id)
           then 'факт' else 'нет' end

    -- Возврат в работу после срыва сделки — тоже факт: открытой сделки
    -- больше нет. А из `new` это решение человека: он поговорил с клиентом.
    when p_new = 'qualified' then
      case when p_old in ('in_showings', 'in_deal')
                and not app.requirement_has_open_deal(p_requirement_id)
           then 'факт'
           when p_old = 'new' then 'решение'
           else 'нет' end

    when p_new = 'lost' then
      case when app.requirement_has_open_deal(p_requirement_id) then 'нет'
           when p_old in ('new', 'qualified', 'in_showings') then 'решение'
           else 'нет' end

    -- Назад в «новый» не возвращаются ничем: это стирание работы.
    else 'нет'
  end
$$;

comment on function app.funnel_move_kind is
  'Инвариант 30. Чем держится переход по воронке: «факт» (случилась работа), «решение» (его принимает агент потребности) или «нет» (перехода не существует).';

create or replace function app.check_requirement_funnel() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_kind text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_kind := app.funnel_move_kind(old.status, new.status, new.id);

  if v_kind = 'нет' then
    raise exception
      'INVARIANT_30: из «%» в «%» воронка не двигается: нет того, что это значит',
      old.status, new.status
      using errcode = 'check_violation',
            hint = 'Колонка воронки — следствие работы. Заведите сделку, проведите показ или закройте клиента с причиной.';
  end if;

  -- Решение принимает агент потребности или администратор. Проверка стоит в
  -- триггере, а не только в политике: update_requirement() и соседи —
  -- security definer, и политика в них не работает вовсе. Урок инварианта 28.
  if v_kind = 'решение'
     and auth.uid() is not null
     and not app.is_admin()
     and new.agent_id is distinct from app.current_agent_id() then
    raise exception 'INVARIANT_30: клиента по воронке двигает его агент'
      using errcode = '42501';
  end if;

  -- Проигрыш без причины — это молчание, а не исход. То же правило, что у
  -- отказа по обращению (инвариант 9).
  if new.status = 'lost'
     and length(btrim(coalesce(new.closed_reason, ''))) = 0 then
    raise exception 'INVARIANT_30: у проигранного клиента обязательна причина'
      using errcode = 'check_violation',
            hint = 'Через полгода «просто ушёл» не объяснит ничего ни вам, ни руководителю.';
  end if;

  return new;
end $$;

create trigger c_requirement_funnel
  before update of status on requirements
  for each row execute function app.check_requirement_funnel();

-- ---------------------------------------------------------------------------
-- Два перехода, которые и есть решение агента
-- ---------------------------------------------------------------------------

create or replace function qualify_requirement(p_requirement_id uuid)
  returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r requirements;
begin
  perform app.require_agent();
  update requirements set status = 'qualified'
   where id = p_requirement_id
  returning * into r;

  if r.id is null then
    raise exception 'потребность % не найдена', p_requirement_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function qualify_requirement is
  'Инвариант 30. «Разобрался, что клиент ищет»: единственный переход воронки, который агент делает руками с начала.';

create or replace function lose_requirement(p_requirement_id uuid, p_reason text)
  returns requirements
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r requirements;
begin
  perform app.require_agent();

  -- Пустую причину ловит триггер, и здесь её НЕ проверяем повторно.
  -- Мутационная проверка показала почему: со снятой проверкой в функции
  -- ничего не менялось — её держал триггер. Две проверки одного правила
  -- прячут друг друга, и сломанную не замечает ни один тест (урок
  -- инварианта 28).
  update requirements
     set status = 'lost', closed_reason = btrim(p_reason)
   where id = p_requirement_id
  returning * into r;

  if r.id is null then
    raise exception 'потребность % не найдена', p_requirement_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function lose_requirement is
  'Инвариант 30. Клиент ушёл. Причина обязательна, возврата нет: вернулся — заводится новая потребность.';

-- ---------------------------------------------------------------------------
-- Сама воронка
-- ---------------------------------------------------------------------------
-- Представление, а не таблица: у колонки нет своего поля, и разойтись с
-- работой ей нечем. Имя клиента видно по правилам инварианта 4 — витрина
-- берёт его из contacts, и политика контактов решает, кому он виден.

create or replace function app.requirement_stage_days(p_status requirement_status)
  returns integer
  language sql immutable as $$
  select case p_status
    -- Новый клиент ждёт звонка сегодня, а не на неделе.
    when 'new'         then 2
    -- Разобрали, но не показали ничего: через две недели он уже у другого.
    when 'qualified'   then 14
    -- Ходит на показы и не выбирает — повод поговорить, а не ждать.
    when 'in_showings' then 30
    -- У сделки свои сроки по этапам (инвариант 24), здесь их дублировать
    -- незачем: два числа об одном разойдутся.
    else null
  end
$$;

comment on function app.requirement_stage_days is
  'Инвариант 30. Сколько дней колонка считается нормальной. Дальше карточка видна как вставшая.';

create or replace view funnel_v
  with (security_invoker = true) as
select
  r.id                          as requirement_id,
  r.status,
  r.stage_since,
  r.agent_id,
  a.full_name                   as agent_name,
  r.contact_id,
  c.name                        as contact_name,
  r.deal_type,
  r.budget_min,
  r.budget_max,
  r.zones,
  r.rooms,
  r.deadline,
  r.closed_reason,
  extract(day from now() - r.stage_since)::int as days_in_stage,
  app.requirement_stage_days(r.status)         as stage_limit_days,
  (app.requirement_stage_days(r.status) is not null
     and r.stage_since < now()
         - make_interval(days => app.requirement_stage_days(r.status))) as stuck,
  (select count(*) from matches m
    where m.requirement_id = r.id and m.status <> 'rejected')::int as matches_count,
  (select count(*) from showings s join matches m on m.id = s.match_id
    where m.requirement_id = r.id and s.status = 'done')::int       as showings_done,
  (select min(s.scheduled_at) from showings s join matches m on m.id = s.match_id
    where m.requirement_id = r.id and s.status = 'scheduled'
      and s.scheduled_at > now())                                   as next_showing_at
from requirements r
join agents a        on a.id = r.agent_id
-- LEFT, и это не мелочь. Имя клиента видно по правилам инварианта 4: чужой
-- контакт политика не отдаёт. С обычным join такая карточка пропадала из
-- воронки ЦЕЛИКОМ — колонка «Купил» показывала ноль при закрытой сделке, и
-- счёт по агентству врал. Инвариант 4 прячет ИМЯ, а не существование работы.
left join contacts c on c.id = r.contact_id;

comment on view funnel_v is
  'Инвариант 30. Воронка: колонка, сколько в ней стоим и чем подкреплена. Поля «колонка» в базе нет — есть состояние потребности.';

create or replace view stuck_requirements_v
  with (security_invoker = true) as
select * from funnel_v where stuck;

comment on view stuck_requirements_v is
  'Инвариант 30. Карточки, стоящие в колонке дольше положенного. Отчёт, а не автоматическое действие: клиента система не закрывает сама.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.touch_requirement_stage(),
  app.requirement_has_done_showing(uuid),
  app.requirement_has_open_deal(uuid),
  app.requirement_has_closed_deal(uuid),
  app.funnel_move_kind(requirement_status, requirement_status, uuid),
  app.check_requirement_funnel(),
  app.requirement_stage_days(requirement_status),
  qualify_requirement(uuid),
  lose_requirement(uuid, text)
  from public;

grant execute on function
  app.requirement_stage_days(requirement_status),
  qualify_requirement(uuid),
  lose_requirement(uuid, text)
  to authenticated;

grant select on funnel_v, stuck_requirements_v to authenticated;
revoke all on funnel_v, stuck_requirements_v from anon;
