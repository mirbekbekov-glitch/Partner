-- 0031_showings.sql
-- ИНВАРИАНТ 25: показ это встреча, а не запись в журнале.
--
-- Инвариант 8 (0009) поставил показ на правильное место: своя таблица, своя
-- история, показ внутри подбора и только участником подбора. Проверка
-- участия стоит в триггере b_showing_match — но только на том, КТО ПРОВОДИТ
-- показ (showings.agent_id). На том, кто показ ТРОГАЕТ, её нет.
--
-- Таблица защищена: RLS не даёт постороннему ни увидеть чужой показ, ни
-- изменить его. А три функции доступа — schedule_showing, complete_showing,
-- cancel_showing — объявлены security definer и RLS не видят. Они спрашивают
-- app.require_agent(): «есть ли вообще вошедший агент». Это пятый раз, когда
-- «агент» оказывается не «этот агент»:
--
--   set request.jwt.claims = '{"sub":"...чужой агент..."}';
--   select count(*) from showings;                       -- 0, не вижу ничего
--   select complete_showing('<чужой показ>', 'rejected', 'якобы не подошло');
--   -- done, rejected
--
-- Агент, который не ведёт этого клиента, не создавал подбор и не отвечает за
-- объект, не видит показа — и закрывает его с любым исходом. Исход уходит в
-- отчёт собственнику: «показов 3, из них отказ 1». Собственник читает приговор
-- своей квартире, написанный человеком, который этой квартиры не видел.
--
-- Дверь заперта, а служебный вход открыт. Отсюда вывод про устройство: правило
-- доступа, которое живёт внутри функции, защищает одну функцию. Следующая
-- функция о нём не узнает. Поэтому проверка переезжает в триггер — там она
-- стоит на таблице, а не на пути к ней.
--
-- По дороге нашлось ещё четыре дыры, и все они про то же: показ был записью
-- в журнале, а не встречей в календаре.
--
--   2. Показ назначается в любое прошлое: schedule_showing(m, '2019-01-01').
--   3. Показ «проходит» раньше, чем наступает: назначить на следующую неделю
--      и сразу закрыть — done_at меньше scheduled_at. Так чистят список.
--   4. Агент стоит в двух местах одновременно: пересечений никто не считает.
--   5. Показ бессмертен. Сделка закрыта, объект снят, потребность закрыта —
--      а назначенный показ остался. Завершить нельзя (потребность закрыта),
--      отменить нельзя (та же проверка), удалить нельзя. Даже админу.
--      Он навсегда в календаре агента и в отчёте собственнику как
--      «назначено 1» по проданной квартире.
--
-- И одно, чего не было вовсе: исход no_show. В enum он есть с 0009, функции
-- для него нет, а «клиент не пришёл» — обычный день. В отчёте собственнику
-- он складывался с отменами, хотя это разные вещи: отменил агент или клиент
-- не приехал — собственнику важно знать, что именно.

-- ---------------------------------------------------------------------------
-- Сколько длится показ
-- ---------------------------------------------------------------------------
-- Числом в коде это было бы магической константой. Функцией — правилом, у
-- которого есть причина и которое видно из отчётов.

create or replace function app.showing_slot() returns interval
  language sql immutable set search_path = pg_temp as $$
  select interval '1 hour'
$$;

comment on function app.showing_slot is
  'Сколько показ занимает времени агента: сам показ плюс дорога. В Бишкеке меньше часа не выходит. На этом держатся проверка пересечений и отбор просроченных.';

create or replace function app.at_bishkek(p_at timestamptz) returns text
  language sql immutable set search_path = pg_temp as $$
  select to_char(p_at at time zone 'Asia/Bishkek', 'DD.MM в HH24:MI')
$$;

comment on function app.at_bishkek is
  'Время для человека, по Бишкеку. Сообщения базы кабинет показывает агенту как есть (web/app/cabinet/actions.ts, humanize), а «2026-11-22 10:00:00+06» глазами не читается.';

create or replace function app.showing_backdate_limit() returns interval
  language sql immutable set search_path = pg_temp as $$
  select interval '2 days'
$$;

comment on function app.showing_backdate_limit is
  'Насколько в прошлое можно НАЗНАЧИТЬ показ. Агент, забывший записать утренний показ, назначит его вечером на утро — это норма; 2019 год это опечатка. Состоявшийся показ записывается любой прошлой датой: это история, а не встреча.';

-- ---------------------------------------------------------------------------
-- Когда показ стал невозможен
-- ---------------------------------------------------------------------------
-- Условие каскада и единственное основание, по которому базе разрешено
-- снять показ без агента. Подделать его посторонний не может: чтобы оно
-- стало правдой, надо закрыть чужую потребность или чужой договор, а этого
-- не даст инвариант 22.

create or replace function app.showing_impossible(p_match_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from matches m
      join requirements r on r.id = m.requirement_id
      join mandates md on md.object_id = m.object_id and md.status = 'active'
     where m.id = p_match_id
       and m.status <> 'rejected'
       and r.status not in ('closed', 'lost'))
$$;

comment on function app.showing_impossible is
  'Показ состояться не может: подбор отклонён, потребность закрыта или у объекта нет действующего договора. Каскад снимает такие показы, и только такие.';

-- ---------------------------------------------------------------------------
-- Инвариант 25: кто трогает показ
-- ---------------------------------------------------------------------------
-- Участник подбора, проводящий агент, админ — или сама база, когда показ стал
-- невозможен. Проводящий агент назван отдельно: после передачи объекта
-- (инвариант 23) он перестаёт быть участником подбора, но показ провёл он, и
-- записать исход должен он.

create or replace function app.can_move_showing(
  p_match_id uuid,
  p_agent_id uuid
) returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select app.is_admin()
      or app.current_agent_id() = p_agent_id
      or app.is_match_participant(p_match_id, app.current_agent_id())
$$;

comment on function app.can_move_showing is
  'Инвариант 25. Показ двигает участник подбора, проводящий агент или админ.';

create or replace function app.check_showing_editor() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_match uuid := coalesce(new.match_id, old.match_id);
  v_agent uuid := coalesce(new.agent_id, old.agent_id);
begin
  -- Без вошедшего агента показы трогают только миграции, засев и обслуживание.
  -- Это не лазейка, и не вопрос доверия: обе двери к таблице уже требуют
  -- агента. Функции доступа спрашивают app.require_agent(), а прямой UPDATE
  -- закрыт политикой showings_update, которой нужен участник подбора.
  -- Посторонний, обнуливший свои claims, теряет обе — это проверяется тестом.
  if auth.uid() is null then
    return new;
  end if;

  if app.can_move_showing(v_match, v_agent) then
    return new;
  end if;

  -- Единственное исключение: снятие ставшего невозможным показа. Так работает
  -- каскад — и так же работает обслуживание, у которого вошедшего агента нет
  -- вовсе. Исключение описано формой изменения, а не доверием к вызывающему:
  -- флаг «я система» посторонний поставил бы себе сам.
  if tg_op = 'UPDATE'
     and old.status = 'scheduled'
     and new.status = 'cancelled'
     and app.showing_impossible(v_match)
  then
    return new;
  end if;

  raise exception
    'INVARIANT_25: показ ведут участники подбора; агент % в подборе % не участвует',
    coalesce(app.current_agent_id()::text, 'без входа'), v_match
    using errcode = '42501',
          hint = 'Исход показа записывает тот, кто его проводил.';
end $$;

comment on function app.check_showing_editor is
  'Инвариант 25. Стоит на таблице, а не внутри функций доступа: функции объявлены security definer и RLS не видят, поэтому правило внутри функции защищает одну функцию.';

create trigger c_showing_editor
  before insert or update on showings
  for each row execute function app.check_showing_editor();

-- ---------------------------------------------------------------------------
-- Инвариант 25: показ как встреча во времени
-- ---------------------------------------------------------------------------
-- Переписанная проверка инварианта 8. Что изменилось:
--
--   — проверки «подбор отклонён» и «потребность закрыта» применяются при
--     создании показа и при его завершении, но НЕ при снятии. Иначе показ
--     становится бессмертным: объект ушёл, а запись не закрыть ничем;
--   — время показа не уходит в далёкое прошлое;
--   — состоявшийся показ не бывает раньше назначенного времени;
--   — назначенные показы одного агента по разным объектам не пересекаются.

create or replace function app.check_showing_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m          matches%rowtype;
  req        requirements%rowtype;
  v_conflict timestamptz;
  v_where    text;
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
-- Инвариант 25: показ, который стал невозможен, снимается сам
-- ---------------------------------------------------------------------------
-- Последствие живёт в триггерах причин, а не в функциях: сделка закрывается
-- функцией, мандат истекает обслуживанием, потребность теряется правкой — и
-- каждый из этих путей обязан убрать назначенные показы. Урок инвариантов
-- 21 и 24: последствие в функции работает для одного вызова, последствие в
-- триггере — для любого пути.

create or replace function app.cancel_impossible_showings(
  p_object_id      uuid default null,
  p_requirement_id uuid default null,
  p_match_id       uuid default null,
  p_reason         text default 'показ стал невозможен'
) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  with doomed as (
    select s.id
      from showings s
      join matches m on m.id = s.match_id
     where s.status = 'scheduled'
       and (p_object_id      is null or m.object_id      = p_object_id)
       and (p_requirement_id is null or m.requirement_id = p_requirement_id)
       and (p_match_id       is null or m.id             = p_match_id)
       and app.showing_impossible(m.id)
  )
  update showings s
     set status = 'cancelled',
         cancel_reason = p_reason
   where s.id in (select id from doomed);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

comment on function app.cancel_impossible_showings is
  'Инвариант 25. Снимает назначенные показы, которые уже не состоятся. Проверяет app.showing_impossible() для каждого: вызов с чужим object_id ничего не снимет, пока показ возможен.';

create or replace function app.showings_follow_mandate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    perform app.cancel_impossible_showings(
      p_object_id => new.object_id,
      p_reason    => 'объект ушёл: договор ' || new.status::text);
  end if;
  return null;
end $$;

create trigger zy_showings_follow_mandate
  after update on mandates
  for each row execute function app.showings_follow_mandate();

create or replace function app.showings_follow_requirement() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status not in ('closed', 'lost') and new.status in ('closed', 'lost') then
    perform app.cancel_impossible_showings(
      p_requirement_id => new.id,
      p_reason         => 'клиент больше не ищет: потребность ' || new.status::text);
  end if;
  return null;
end $$;

create trigger zy_showings_follow_requirement
  after update on requirements
  for each row execute function app.showings_follow_requirement();

create or replace function app.showings_follow_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status <> 'rejected' and new.status = 'rejected' then
    perform app.cancel_impossible_showings(
      p_match_id => new.id,
      p_reason   => 'объект клиенту не подошёл');
  end if;
  return null;
end $$;

create trigger zy_showings_follow_match
  after update on matches
  for each row execute function app.showings_follow_match();

-- ---------------------------------------------------------------------------
-- Клиент не пришёл
-- ---------------------------------------------------------------------------
-- Не отмена: отменяют договорившись, а здесь агент приехал и стоял у подъезда.
-- Для собственника это разные новости, поэтому и состояние своё.

create or replace function mark_no_show(
  p_showing_id uuid,
  p_note       text default null
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
    raise exception 'показ уже в состоянии %, отметить неявку нельзя', s.status
      using errcode = 'check_violation';
  end if;

  update showings
     set status = 'no_show',
         note   = coalesce(p_note, note)
   where id = p_showing_id
  returning * into r;

  return r;
end $$;

comment on function mark_no_show is
  'Клиент не пришёл. Отдельно от отмены: собственнику важно, отменил агент или не приехал клиент.';

-- ---------------------------------------------------------------------------
-- Завершение показа: понятная ошибка вместо ошибки триггера
-- ---------------------------------------------------------------------------
-- Правила держит триггер, но сообщение из триггера говорит про done_at, а
-- агент видел на экране кнопку. Функция называет то же правило словами.

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

  if s.scheduled_at > now() then
    raise exception
      'INVARIANT_25: показ назначен на %, он ещё не наступил',
      app.at_bishkek(s.scheduled_at)
      using errcode = 'check_violation',
            hint = 'Если показ состоялся раньше, сначала перенесите его время.';
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
  'Завершить показ с результатом. Двигает подбор в showing_done, потребность в in_showings. Будущий показ закрыть нельзя: сначала перенести время.';

-- ---------------------------------------------------------------------------
-- Перенос показа
-- ---------------------------------------------------------------------------
-- Переносят показы постоянно, и до этой миграции переносить было нечем:
-- кабинет умел только отменить и назначить заново, а это теряет историю
-- переноса и ломает подбор (showing_scheduled уходит в interested и обратно).

create or replace function reschedule_showing(
  p_showing_id uuid,
  p_at         timestamptz
) returns showings
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s showings%rowtype;
  r showings;
begin
  perform app.require_agent();

  if p_at is null then
    raise exception 'время показа обязательно' using errcode = 'not_null_violation';
  end if;

  select * into s from showings where id = p_showing_id;
  if not found then
    raise exception 'показ % не найден', p_showing_id using errcode = 'no_data_found';
  end if;

  if s.status <> 'scheduled' then
    raise exception 'показ в состоянии %, переносить нечего', s.status
      using errcode = 'check_violation';
  end if;

  update showings set scheduled_at = p_at where id = p_showing_id
  returning * into r;

  return r;
end $$;

comment on function reschedule_showing is
  'Перенести назначенный показ. Проверки времени и пересечений делает триггер инварианта 25.';

-- ---------------------------------------------------------------------------
-- День агента
-- ---------------------------------------------------------------------------
-- Показ это то, из чего состоит день: куда ехать, к кому и когда. Отдельного
-- экрана у показов не было — они жили внутри карточки клиента, по одному
-- назначенному на подбор. Этот вид отвечает на вопрос «что у меня сегодня».

create or replace view my_showings_v
  with (security_invoker = true) as
select
  s.id,
  s.match_id,
  s.status,
  s.scheduled_at,
  s.done_at,
  s.outcome,
  s.client_reaction,
  s.note,
  s.cancel_reason,
  s.agent_id,
  ag.full_name as agent_name,
  s.agent_id = app.current_agent_id() as i_lead,
  o.id         as object_id,
  o.address,
  o.zone,
  o.kind,
  o.deal_type,
  o.price,
  o.currency,
  o.rooms,
  r.id         as requirement_id,
  c.name       as client_name,
  -- Просрочен: назначенное время прошло вместе со сроком показа, а исхода
  -- никто не записал. Это не «опоздал», это «забыл закрыть».
  s.status = 'scheduled'
    and s.scheduled_at < now() - app.showing_slot() as overdue,
  (s.scheduled_at at time zone 'Asia/Bishkek')::date as on_day
from showings s
join matches      m  on m.id  = s.match_id
join objects      o  on o.id  = m.object_id
join requirements r  on r.id  = m.requirement_id
left join agents  ag on ag.id = s.agent_id
left join contacts c on c.id  = r.contact_id;

comment on view my_showings_v is
  'Показы, видимые агенту (RLS таблицы). Отвечает на «что у меня сегодня» и помечает просроченные.';

create or replace view overdue_showings_v
  with (security_invoker = true) as
select * from my_showings_v where overdue;

comment on view overdue_showings_v is
  'Инвариант 25. Назначенный показ, у которого время прошло, а исхода нет. Молчание о показе не значит, что он прошёл хорошо.';

-- ---------------------------------------------------------------------------
-- Отчёт собственнику: неявка это не отмена
-- ---------------------------------------------------------------------------
-- Единственная правка 0013: отмены и неявки перестают складываться. Для
-- собственника это разные новости, и вторая говорит о спросе, а не о работе
-- агентства.

create or replace function app.owner_report(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a      owner_access%rowtype;
  o      objects%rowtype;
  v_out  jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;

  select * into a from owner_access where token = p_token;
  if not found
     or a.revoked_at is not null
     or (a.expires_at is not null and a.expires_at < now()) then
    return null;
  end if;

  select * into o from objects where id = a.object_id;
  if not found then
    return null;
  end if;

  -- Просмотр считается здесь: агенту важно знать, дошла ли ссылка.
  update owner_access
     set view_count = view_count + 1, last_viewed_at = now()
   where id = a.id;

  select jsonb_build_object(
    'object', jsonb_build_object(
      'address',           o.address,
      'zone',              o.zone,
      'kind',              o.kind,
      'deal_type',         o.deal_type,
      'rooms',             o.rooms,
      'area',              o.area,
      'floor',             o.floor,
      'floors_total',      o.floors_total,
      'price',             o.price,
      'currency',          o.currency,
      'publication_state', o.publication_state,
      'published_at',      o.published_at,
      'actual_at',         o.actual_at
    ),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel',      pc.channel,
               'status',       pc.status,
               'last_sync_at', pc.last_sync_at,
               'has_error',    pc.last_error is not null)
             order by pc.channel)
        from publication_channels pc where pc.object_id = o.id
    ), '[]'::jsonb),
    'showings', (
      select jsonb_build_object(
        'scheduled', count(*) filter (where s.status = 'scheduled'),
        'done',      count(*) filter (where s.status = 'done'),
        'cancelled', count(*) filter (where s.status = 'cancelled'),
        -- Неявка перестаёт складываться с отменой: отменил агент или не
        -- приехал клиент — собственнику это разные новости (инвариант 25).
        'no_show',   count(*) filter (where s.status = 'no_show'),
        'last_done_at', max(s.done_at) filter (where s.status = 'done'),
        -- Только структурная реакция: свободный текст с показа собственнику
        -- не отдаётся, там чужие слова и чужие контакты.
        'outcomes', coalesce(jsonb_object_agg(s.outcome, s.cnt)
                     filter (where s.outcome is not null), '{}'::jsonb))
      from (
        select sh.status, sh.outcome, sh.done_at, count(*) over (
                 partition by sh.outcome) as cnt
          from showings sh
          join matches mt on mt.id = sh.match_id
         where mt.object_id = o.id
      ) s
    ),
    'interest', jsonb_build_object(
      'matches', (select count(*) from matches mt where mt.object_id = o.id),
      'rejected', (select count(*) from matches mt
                    where mt.object_id = o.id and mt.status = 'rejected')
    ),
    -- История цены берётся из журнала (инвариант 7): отдельной таблицы
    -- для неё нет и не нужно. Считаются только правки: у вставки в diff
    -- попадает вся строка, и создание объекта засчиталось бы как изменение
    -- цены, которого не было.
    'price_changes', (
      select jsonb_build_object(
        'count', count(*),
        'last_at', max(al.at))
        from audit_log al
       where al.entity_type = 'object' and al.entity_id = o.id
         and al.action = 'update'
         and al.diff ? 'price'
    ),
    'report', jsonb_build_object(
      'generated_at', now(),
      'views',        a.view_count + 1
    )
  ) into v_out;

  return v_out;
end $$;

-- Инвариант 15: новая функция по умолчанию открыта PUBLIC, а revoke из 0018
-- подействовал только на то, что существовало тогда. Поэтому каждая миграция
-- закрывает своё — и структурный сторож из inv15 это проверяет.
revoke execute on function
  app.at_bishkek(timestamptz),
  app.showing_slot(),
  app.showing_backdate_limit(),
  app.showing_impossible(uuid),
  app.can_move_showing(uuid, uuid),
  app.check_showing_editor(),
  app.cancel_impossible_showings(uuid, uuid, uuid, text),
  app.showings_follow_mandate(),
  app.showings_follow_requirement(),
  app.showings_follow_match(),
  mark_no_show(uuid, text),
  reschedule_showing(uuid, timestamptz)
  from public;

grant execute on function app.at_bishkek(timestamptz),
                         app.showing_slot(),
                         app.showing_backdate_limit(),
                         app.showing_impossible(uuid),
                         app.can_move_showing(uuid, uuid),
                         mark_no_show(uuid, text),
                         reschedule_showing(uuid, timestamptz)
  to authenticated;

grant select on my_showings_v, overdue_showings_v to authenticated;
revoke all on my_showings_v, overdue_showings_v from anon;
