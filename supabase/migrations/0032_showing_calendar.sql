-- 0032_showing_calendar.sql
-- ИНВАРИАНТ 26: назначенный показ помещается в календарь — и в срок договора.
--
-- Инвариант 25 дал показу время и запретил агенту быть в двух местах сразу.
-- Экран показов сделал из этого день. Календарь — неделя — спрашивает строже:
-- у недели есть границы, и всё, что в них не помещается, из календаря
-- пропадает. А показ, которого не видно, хуже показа, который не дали
-- назначить.
--
-- Три пробы, три дыры.
--
--   1. Показ в три часа ночи:
--
--        select schedule_showing(m, '2026-11-23 03:00 Asia/Bishkek');  -- ок
--
--      Никто не откроет дверь, а в сетке календаря этого часа нет — показ
--      просто исчезает с экрана. Чаще всего это опечатка: 03:00 вместо 15:00,
--      и поймать её надо там, где её делают.
--
--   2. Показ ПОСЛЕ окончания договора. Договор кончается через пять дней,
--      показ назначен через двадцать:
--
--        update mandates set valid_to = current_date + 5 where ...;
--        select schedule_showing(m, now() + interval '20 days');       -- ок
--
--      К тому дню обслуживание закроет мандат, каскад инварианта 25 снимет
--      показ — и агент узнает об этом, только не найдя встречу в календаре.
--      Клиенту он её уже пообещал.
--
--   3. Показ ДО начала договора. Договор начинается через десять дней, показ
--      назначен на послезавтра. Это хуже первых двух: агент приводит клиента
--      в чужую квартиру без права её показывать. Ровно это платформа и
--      обещает не делать — «только с действующим договором» написано у неё
--      на первой странице.
--
-- Все три — об одном: у назначенной встречи должно быть время, в которое она
-- может состояться. Час, в который открывают дверь, и день, в который у
-- агентства есть договор.
--
-- Чего здесь СОЗНАТЕЛЬНО нет: запрета двум агентам показывать один объект в
-- один час. Инвариант 25 считает занятым агента, а не объект, и это
-- правильно — показать квартиру двум клиентам подряд обычная работа. Но два
-- РАЗНЫХ агента с двумя группами у одной двери — не работа, а неловкость,
-- и отвечает за неё listing-агент. База это не запрещает: совместный показ
-- бывает по договорённости. Календарь это показывает — `showing_clashes_v`.
-- Координация лечится видимостью, а не запретом.

-- ---------------------------------------------------------------------------
-- Часы показов
-- ---------------------------------------------------------------------------
-- Окно широкое: лучше пропустить поздний показ, чем заставить агента врать
-- системе о времени. Но ночь оно отсекает, и сетка календаря рисуется ровно
-- по нему — поэтому «не видно в календаре» невозможно по построению.

create or replace function app.showing_opens() returns time
  language sql immutable set search_path = pg_temp as $$
  select time '08:00'
$$;

create or replace function app.showing_closes() returns time
  language sql immutable set search_path = pg_temp as $$
  select time '21:00'
$$;

comment on function app.showing_opens is
  'Инвариант 26. Раньше этого часа показ не назначают. По этим же часам рисуется сетка календаря: правило и экран берут число из одного места.';
comment on function app.showing_closes is
  'Инвариант 26. Позже этого часа показ не НАЧИНАЕТСЯ; длится он app.showing_slot() и может закончиться позже.';

-- ---------------------------------------------------------------------------
-- Срок договора на объект
-- ---------------------------------------------------------------------------

create or replace function app.mandate_window(p_object_id uuid)
  returns table (valid_from date, valid_to date)
  language sql stable security definer set search_path = public, pg_temp as $$
  select md.valid_from, md.valid_to
    from mandates md
   where md.object_id = p_object_id and md.status = 'active'
$$;

comment on function app.mandate_window is
  'Срок действующего договора на объект. Пустой результат — договора нет; показ при этом невозможен и без того (инвариант 25). LIMIT 1 здесь нет сознательно: действующий договор ровно один по инварианту 1, и если это когда-нибудь перестанет быть правдой, лучше узнать, чем молча взять первый попавшийся.';

-- ---------------------------------------------------------------------------
-- Инвариант 26: проверка при записи
-- ---------------------------------------------------------------------------
-- Функция целиком пересоздаётся: правила показа живут в одном триггере, а не
-- расползаются по миграциям отдельными проверками.

create or replace function app.check_showing_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m          matches%rowtype;
  req        requirements%rowtype;
  v_conflict timestamptz;
  v_where    text;
  v_local    time;
  v_from     date;
  v_to       date;
begin
  if new.match_id is null then
    raise exception 'INVARIANT_8: показ без подбора невозможен'
      using errcode = 'not_null_violation';
  end if;

  if tg_op = 'UPDATE' and new.match_id <> old.match_id then
    raise exception 'INVARIANT_8: подбор показа менять нельзя'
      using errcode = 'check_violation';
  end if;

  select * into m from matches where id = new.match_id;
  if not found then
    raise exception 'INVARIANT_8: показ ссылается на несуществующий подбор %', new.match_id
      using errcode = 'foreign_key_violation';
  end if;

  select * into req from requirements where id = m.requirement_id;

  -- Снятие показа и «клиент не пришёл» разрешены всегда: это и есть выход из
  -- состояния, в которое показ попал не по своей вине.
  if tg_op = 'INSERT' or new.status in ('scheduled', 'done') then
    if m.status = 'rejected' then
      raise exception 'INVARIANT_8: подбор отклонён, показ невозможен'
        using errcode = 'check_violation',
              hint = 'Создайте новый подбор, если клиент вернулся к объекту.';
    end if;

    if req.status in ('closed', 'lost') then
      raise exception 'INVARIANT_8: потребность закрыта, показ невозможен'
        using errcode = 'check_violation',
              hint = 'Назначенный показ при этом можно снять: он уже не состоится.';
    end if;
  end if;

  -- Показ проводит участник подбора (инвариант 8). Проверяется при создании и
  -- при смене проводящего: у старого показа listing-агент мог измениться
  -- передачей объекта, и перепроверка отобрала бы у него собственный показ.
  if tg_op = 'INSERT' or new.agent_id <> old.agent_id then
    if not app.is_match_participant(new.match_id, new.agent_id) then
      raise exception
        'INVARIANT_8: агент % не участвует в подборе %, показ назначить нельзя',
        new.agent_id, new.match_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- ИНВАРИАНТ 25: время. Ограничение на прошлое касается только НАЗНАЧЕННОГО
  -- показа: назначить встречу на 2019 год нельзя, а записать состоявшийся
  -- показ задним числом — обычное дело, в том числе при переносе истории.
  -- Поэтому проверяется состояние, а не только дата.
  if new.status = 'scheduled'
     and (tg_op = 'INSERT' or new.scheduled_at <> old.scheduled_at or old.status <> 'scheduled')
  then
    if new.scheduled_at < now() - app.showing_backdate_limit() then
      raise exception
        'INVARIANT_25: показ нельзя назначить так далеко в прошлое (%)',
        app.at_bishkek(new.scheduled_at)
        using errcode = 'check_violation',
              hint = 'Забытый показ записывают сразу состоявшимся; назначить встречу в прошлое нельзя.';
    end if;
  end if;

  if new.status = 'done' and new.done_at < new.scheduled_at then
    raise exception
      'INVARIANT_25: показ не может пройти раньше, чем наступит: назначен на %, закрыт %',
      app.at_bishkek(new.scheduled_at), app.at_bishkek(new.done_at)
      using errcode = 'check_violation',
            hint = 'Если показ состоялся раньше, перенесите его время, а потом закрывайте.';
  end if;

  -- ИНВАРИАНТ 26: встреча помещается в календарь.
  --
  -- Проверяется только НАЗНАЧЕННЫЙ показ. Состоявшийся записывается любой
  -- датой и в любой час: это история, в ней ничего не чинится запретом.
  if new.status = 'scheduled'
     and (tg_op = 'INSERT'
          or new.scheduled_at <> old.scheduled_at
          or old.status <> 'scheduled')
  then
    v_local := (new.scheduled_at at time zone 'Asia/Bishkek')::time;

    if v_local < app.showing_opens() or v_local > app.showing_closes() then
      raise exception
        'INVARIANT_26: показы назначают с % до %, а это %',
        to_char(app.showing_opens(), 'HH24:MI'),
        to_char(app.showing_closes(), 'HH24:MI'),
        to_char(v_local, 'HH24:MI')
        using errcode = 'check_violation',
              hint = 'Показ вне этих часов не виден в календаре, а 03:00 чаще всего опечатка вместо 15:00.';
    end if;

    -- Срок договора. Показывать объект можно, пока на него есть действующий
    -- договор: в этом всё обещание платформы собственнику. Назначить показ
    -- на время, когда договора ещё или уже нет, значит пообещать клиенту
    -- встречу, на которую агент не имеет права прийти.
    select w.valid_from, w.valid_to into v_from, v_to
      from app.mandate_window(m.object_id) w;

    if v_from is not null
       and (new.scheduled_at at time zone 'Asia/Bishkek')::date < v_from then
      raise exception
        'INVARIANT_26: договор на объект начинается %, раньше показывать нечего',
        to_char(v_from, 'DD.MM.YYYY')
        using errcode = 'check_violation';
    end if;

    if v_to is not null
       and (new.scheduled_at at time zone 'Asia/Bishkek')::date > v_to then
      raise exception
        'INVARIANT_26: договор на объект кончается %, показ назначен на %',
        to_char(v_to, 'DD.MM.YYYY'), app.at_bishkek(new.scheduled_at)
        using errcode = 'check_violation',
              hint = 'Продлите договор или назначьте показ раньше.';
    end if;
  end if;

  -- ИНВАРИАНТ 25: агент не бывает в двух местах одновременно. По одному
  -- объекту пересечение разрешено: агент уже там, и показать квартиру двум
  -- клиентам подряд — обычная работа.
  if new.status = 'scheduled'
     and (tg_op = 'INSERT'
          or new.scheduled_at <> old.scheduled_at
          or new.agent_id <> old.agent_id
          or old.status <> 'scheduled')
  then
    select s.scheduled_at, o.address
      into v_conflict, v_where
      from showings s
      join matches  sm on sm.id = s.match_id
      join objects  o  on o.id  = sm.object_id
     where s.agent_id = new.agent_id
       and s.status = 'scheduled'
       and s.id <> new.id
       and sm.object_id <> m.object_id
       and s.scheduled_at < new.scheduled_at + app.showing_slot()
       and new.scheduled_at < s.scheduled_at + app.showing_slot()
     order by s.scheduled_at
     limit 1;

    if v_conflict is not null then
      raise exception
        'INVARIANT_25: в это время у агента уже показ % по адресу %',
        app.at_bishkek(v_conflict), v_where
        using errcode = 'check_violation',
              hint = 'Показ занимает час вместе с дорогой. Выберите другое время.';
    end if;
  end if;

  return new;
end $$;
-- ---------------------------------------------------------------------------
-- Две группы у одной двери
-- ---------------------------------------------------------------------------
-- Не запрет, а видимость: показы РАЗНЫХ агентов по одному объекту,
-- пересекающиеся во времени. Совместный показ бывает по договорённости —
-- но тогда о нём знают оба, а узнать можно только посмотрев.
--
-- Представление с security_invoker: видно ровно то, что видно агенту по
-- политикам таблицы. Listing-агент объекта участвует в каждом подборе по
-- нему, поэтому столкновения на своих объектах он видит все.

create or replace view showing_clashes_v
  with (security_invoker = true) as
select
  s.id,
  s.match_id,
  s.agent_id,
  s.scheduled_at,
  o.id           as object_id,
  o.address,
  other.id       as other_id,
  other.agent_id as other_agent_id,
  oa.full_name   as other_agent_name,
  other.scheduled_at as other_at
from showings s
join matches m on m.id = s.match_id
join objects o on o.id = m.object_id
join matches om on om.object_id = m.object_id
join showings other
  on other.match_id = om.id
 and other.id <> s.id
 and other.status = 'scheduled'
 and other.agent_id <> s.agent_id
 and other.scheduled_at < s.scheduled_at + app.showing_slot()
 and s.scheduled_at < other.scheduled_at + app.showing_slot()
left join agents oa on oa.id = other.agent_id
where s.status = 'scheduled';

comment on view showing_clashes_v is
  'Инвариант 26, оборотная сторона: база не запрещает двум агентам показывать объект в один час, но показывает это. Отвечает перед собственником listing-агент, а узнать он может только посмотрев.';

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke execute on function
  app.showing_opens(), app.showing_closes(), app.mandate_window(uuid)
  from public;

grant execute on function
  app.showing_opens(), app.showing_closes(), app.mandate_window(uuid)
  to authenticated;

grant select on showing_clashes_v to authenticated;
revoke all on showing_clashes_v from anon;
