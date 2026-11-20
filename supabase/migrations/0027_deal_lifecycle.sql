-- 0027_deal_lifecycle.sql
-- ИНВАРИАНТ 21: сделку ведут её участники; закрытая и сорванная сделки
--               окончательны.
--
-- Проверено запросом, и это худшее, что нашлось в этом проекте. Агент,
-- не имеющий к сделке никакого отношения, выполнил подряд:
--
--     select close_deal(d, 100000);     -- закрыл чужую сделку
--     select close_deal(d, 999999);     -- переписал цену закрытой
--     select fail_deal(d, 'передумал'); -- и сорвал её
--
-- Получилась сделка, которой не бывает: status = 'failed' при заполненном
-- closed_at, final_price = 999999 при комиссии, посчитанной от 100000, —
-- то есть комиссия больше не соответствует цене, — а мандат при этом остался
-- closed_by_deal, объект снят с публикации, потребность закрыта.
--
-- Причина простая: close_deal() и fail_deal() спрашивали app.require_agent()
-- и больше ничего. «Агент» — это не «этот агент».
--
-- ЧТО ЗАПИРАЕТСЯ.
--
--   участники   — сделку ведут листинг-агент и агент покупателя. Доля каждого
--                 считается по этим полям (инвариант 3), поэтому посторонний
--                 в сделке — это не беспорядок, это чужие деньги;
--   закрытая    — окончательна. Ни цена, ни комиссия, ни статус. Комиссия
--                 зафиксирована инвариантом 3, а цена, от которой её
--                 посчитали, до сих пор нет — и расхождение между ними хуже
--                 любой из ошибок по отдельности;
--   сорванная   — тоже окончательна. Закрыть сделку задним числом после
--                 срыва значит выдать комиссию по сделке, которой не было.
--
-- Правила стоят в триггере, а не в функциях: роли приложения выдан update на
-- deals, и правило, живущее только в функции, обходится одной строкой.

create or replace function app.check_deal_lifecycle() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_me uuid := app.current_agent_id();
begin
  -- ---- кто ---------------------------------------------------------------
  -- Правило касается запросов из приложения: у миграций и переноса входа
  -- нет, и притворяться, что триггер их останавливает, незачем.
  if auth.uid() is not null and not app.is_admin() then
    if tg_op = 'INSERT' then
      if v_me is distinct from new.listing_agent_id
         and v_me is distinct from new.closing_agent_id then
        raise exception 'INVARIANT_21: сделку заводит её участник'
          using errcode = '42501';
      end if;
    else
      if v_me is distinct from old.listing_agent_id
         and v_me is distinct from old.closing_agent_id then
        raise exception 'INVARIANT_21: сделку ведут её участники'
          using errcode = '42501',
                hint = 'Это сделка другого агента.';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- ---- закрытая окончательна ---------------------------------------------
  if old.status = 'closed' then
    if new.status is distinct from old.status then
      raise exception 'INVARIANT_21: закрытая сделка не меняет состояние (попытка «%»)', new.status
        using errcode = 'check_violation';
    end if;
    if new.final_price      is distinct from old.final_price
       or new.commission_total is distinct from old.commission_total
       or new.listing_share    is distinct from old.listing_share
       or new.closing_share    is distinct from old.closing_share
       or new.closed_at        is distinct from old.closed_at then
      raise exception 'INVARIANT_21: цена и комиссия закрытой сделки неизменны'
        using errcode = 'check_violation',
              hint = 'Если сумма была записана неверно, это исправляется новой сделкой, а не правкой старой.';
    end if;
  end if;

  -- ---- сорванная окончательна --------------------------------------------
  if old.status = 'failed' and new.status is distinct from old.status then
    raise exception 'INVARIANT_21: сорванную сделку не закрыть задним числом'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function app.check_deal_lifecycle is
  'Инвариант 21. Сделку ведут её участники; закрытая и сорванная сделки окончательны.';

-- Имя с «c», чтобы правило проверялось ДО e_deal_closed: тот дописывает
-- комиссию в ту же строку, и проверять надо намерение, а не результат.
create trigger c_deal_lifecycle
  before insert or update on deals
  for each row execute function app.check_deal_lifecycle();

-- ---------------------------------------------------------------------------
-- Комиссия записывается в ту же строку, а не вторым UPDATE
-- ---------------------------------------------------------------------------
-- Инвариант 21 поймал не только дыру, но и устройство: app.on_deal_closed()
-- был триггером AFTER и дописывал суммы ВЛОЖЕННЫМ update по уже закрытой
-- сделке. Для «закрытая неизменна» это означало бы постоянное исключение —
-- мол, системе можно. Исключение в правиле, которое защищает деньги, стоит
-- дороже переделки.
--
-- Поэтому суммы считаются ДО записи и кладутся в саму строку. Запись одна,
-- рекурсии нет, правило работает без оговорок. Внешние последствия закрытия —
-- мандат и потребность — остаются в триггере AFTER: это другие таблицы.

create or replace function app.fix_deal_commission() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_total numeric;
  v_rule  jsonb;
  v_type  deal_type;
  v_ratio numeric;
  s       record;
begin
  if new.status = 'closed' and coalesce(old.status, 'deposit') <> 'closed' then
    select o.deal_type, m.commission_rule, m.closing_share_ratio
      into v_type, v_rule, v_ratio
      from objects o
      join mandates m on m.id = new.mandate_id
     where o.id = new.object_id;

    -- Инвариант 3: после закрытия считаем от ФИНАЛЬНОЙ цены и фиксируем.
    -- Ставку агента покупателя назначает владелец мандата (0010).
    v_total := app.commission_total(v_type, new.final_price, v_rule);
    select * into s from app.commission_shares(v_total, v_ratio);

    new.commission_total := v_total;
    new.listing_share    := s.listing_share;
    new.closing_share    := s.closing_share;
    new.closed_at        := coalesce(new.closed_at, now());
  end if;
  return new;
end $$;

comment on function app.fix_deal_commission is
  'Инварианты 3 и 21. Фиксирует комиссию в самой строке при закрытии: одна запись вместо вложенного UPDATE.';

create trigger d_deal_commission
  before update on deals
  for each row execute function app.fix_deal_commission();

-- Триггер AFTER остаётся, но больше не трогает саму сделку.
create or replace function app.on_deal_closed() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'closed' and coalesce(old.status, 'deposit') <> 'closed' then
    -- Инвариант 2: закрытие сделки закрывает её мандат и её потребность.
    update mandates
       set status = 'closed_by_deal',
           closed_reason = 'закрыт сделкой ' || new.id::text
     where id = new.mandate_id
       and status <> 'closed_by_deal';

    update requirements
       set status = 'closed',
           closed_reason = 'закрыта сделкой ' || new.id::text
     where id = new.requirement_id
       and status <> 'closed';
  end if;
  return null;
end $$;

comment on function app.on_deal_closed is
  'Инвариант 2. Закрытие сделки закрывает её мандат и потребность. Суммы фиксирует d_deal_commission до записи.';

-- ---------------------------------------------------------------------------
-- Понятные отказы вместо непонятных
-- ---------------------------------------------------------------------------
-- Триггер скажет правду в любом случае, но «закрытая сделка не меняет
-- состояние» в ответ на попытку закрыть её второй раз объясняет не то, что
-- человек сделал. Поэтому обе функции отвечают словами про своё действие.

create or replace function close_deal(p_deal_id uuid, p_final_price numeric)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status deal_status;
  r deals;
begin
  perform app.require_agent();

  if p_final_price is null or p_final_price <= 0 then
    raise exception 'финальная цена обязательна для закрытия сделки'
      using errcode = 'check_violation';
  end if;

  select status into v_status from deals where id = p_deal_id;
  if v_status is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;
  if v_status = 'closed' then
    raise exception 'INVARIANT_21: сделка уже закрыта, сумма зафиксирована'
      using errcode = 'check_violation';
  end if;
  if v_status = 'failed' then
    raise exception 'INVARIANT_21: сделка сорвана, закрыть её нельзя'
      using errcode = 'check_violation';
  end if;

  -- Суммы проставляет d_deal_commission ДО записи, мандат и потребность
  -- закрывает e_deal_closed ПОСЛЕ. Оба правила работают и при прямом UPDATE.
  update deals
     set status = 'closed', final_price = p_final_price
   where id = p_deal_id
  returning * into r;

  return r;
end $$;

comment on function close_deal is
  'Инвариант 3 и 21. Фиксирует цену и комиссию. Закрыть можно один раз и только участнику сделки.';

create or replace function fail_deal(p_deal_id uuid, p_reason text)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status deal_status;
  r deals;
begin
  perform app.require_agent();

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'причина срыва обязательна' using errcode = 'check_violation';
  end if;

  select status into v_status from deals where id = p_deal_id;
  if v_status is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;
  if v_status = 'closed' then
    raise exception 'INVARIANT_21: сделка закрыта, сорвать её нельзя'
      using errcode = 'check_violation',
            hint = 'Закрытая сделка — это история. Отменяется она не правкой, а новой сделкой.';
  end if;

  update deals set status = 'failed', failure_reason = p_reason
   where id = p_deal_id returning * into r;

  -- Потребность возвращается в работу: сделка сорвалась, клиент остался.
  update requirements set status = 'qualified'
   where id = r.requirement_id and status = 'in_deal';

  -- Подбор тоже: иначе он навсегда остаётся «в сделке», которой нет, и
  -- предложить этот объект клиенту снова будет нечем.
  update matches set status = 'interested'
   where id = r.match_id and status = 'in_deal';

  return r;
end $$;

comment on function fail_deal is
  'Инвариант 21. Срыв сделки: возвращает потребность и подбор в работу. Закрытую сделку сорвать нельзя.';

-- ---------------------------------------------------------------------------
-- Сделки агента
-- ---------------------------------------------------------------------------
-- Представления комиссии есть, а списка сделок не было: кабинету нечего было
-- показать на экране сделки.

create or replace view agent_deals_v
  with (security_invoker = true) as
select
  d.id              as deal_id,
  d.status,
  d.final_price,
  d.commission_total,
  d.listing_share,
  d.closing_share,
  d.failure_reason,
  d.closed_at,
  d.created_at,
  d.match_id,
  d.object_id,
  o.address,
  o.kind,
  o.deal_type,
  o.price           as asking_price,
  o.currency,
  d.requirement_id,
  rc.name           as client_name,
  d.listing_agent_id,
  la.full_name      as listing_agent_name,
  d.closing_agent_id,
  ca.full_name      as closing_agent_name,
  m.kind            as mandate_kind,
  m.closing_share_ratio,
  (d.listing_agent_id = app.current_agent_id()) as i_am_listing,
  (d.closing_agent_id = app.current_agent_id()) as i_am_closing,
  -- Сколько в этой сделке моего. До закрытия это оценка, после — факт.
  case
    when d.listing_agent_id = app.current_agent_id() then d.listing_share
    when d.closing_agent_id = app.current_agent_id() then d.closing_share
  end as my_share
from deals d
join objects o on o.id = d.object_id
join mandates m on m.id = d.mandate_id
left join requirements r on r.id = d.requirement_id
left join contacts rc on rc.id = r.contact_id
left join agents la on la.id = d.listing_agent_id
left join agents ca on ca.id = d.closing_agent_id;

comment on view agent_deals_v is
  'Сделки для кабинета. Доли до закрытия пусты: индикативные суммы живут в deal_commission_v.';

grant select on agent_deals_v to authenticated;
revoke all on agent_deals_v from anon;

revoke execute on function app.check_deal_lifecycle() from public;
-- Триггерные функции вызывает Postgres, а не роли. Инварианты 15 и 18
-- поймали fix_deal_commission(), оставленную открытой PUBLIC, — это ровно
-- то, зачем они написаны.
revoke execute on function app.fix_deal_commission() from public;
revoke execute on function app.on_deal_closed() from public;
