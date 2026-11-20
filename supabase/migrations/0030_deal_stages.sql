-- 0030_deal_stages.sql
-- ИНВАРИАНТ 24: срыв сделки возвращает клиента и подбор в работу, как бы он
--               ни был сделан; этап сделки датирован, и застрявшая сделка
--               видна.
--
-- Этапы в схеме были с первого дня: deposit, documents, signing, settlement.
-- Пользоваться ими было нечем — кабинет показывал «задаток» до самого
-- закрытия, а база за порядком не следила. Два вопроса, на которые агентство
-- не могло ответить: «на каком этапе сделка» и «сколько она там стоит».
--
-- ДЫРА, НАЙДЕННАЯ ПО ДОРОГЕ. fail_deal() возвращает потребность и подбор в
-- работу — сделка сорвалась, клиент остался. Но срыв прямой правкой этого не
-- делал:
--
--     update deals set status = 'failed', failure_reason = 'мимо функции';
--
-- Сделка сорвана, а потребность и подбор остаются in_deal навсегда: новую
-- сделку по этому клиенту не завести, предложить ему объект снова нельзя.
-- Клиент заперт.
--
-- Чинится так же, как закрытие: последствия переезжают в триггер. В
-- close_deal() об этом уже написано — «правило одно и работает даже при
-- прямом UPDATE», — и для срыва это было просто не сделано.

-- ---------------------------------------------------------------------------
-- Последствия срыва — в триггере
-- ---------------------------------------------------------------------------

create or replace function app.on_deal_failed() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'failed' and coalesce(old.status, 'deposit') <> 'failed' then
    -- Потребность возвращается в работу: сделка сорвалась, клиент остался.
    update requirements set status = 'qualified'
     where id = new.requirement_id and status = 'in_deal';

    -- Подбор тоже: иначе он навсегда остаётся «в сделке», которой нет, и
    -- предложить этот объект клиенту снова будет нечем.
    update matches set status = 'interested'
     where id = new.match_id and status = 'in_deal';
  end if;
  return null;
end $$;

comment on function app.on_deal_failed is
  'Инвариант 24. Срыв возвращает клиента и подбор в работу — при любом пути, включая прямой UPDATE.';

create trigger e_deal_failed
  after update on deals
  for each row execute function app.on_deal_failed();

-- fail_deal() больше не делает этого сама: правило живёт в одном месте.
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

  -- Потребность и подбор возвращает в работу триггер e_deal_failed.
  update deals set status = 'failed', failure_reason = p_reason
   where id = p_deal_id returning * into r;

  return r;
end $$;

comment on function fail_deal is
  'Инвариант 24. Срыв сделки. Последствия — в триггере, поэтому они одинаковы при любом пути.';

-- ---------------------------------------------------------------------------
-- Этап датирован
-- ---------------------------------------------------------------------------
-- Без даты входа в этап нельзя ответить на вопрос «сколько сделка здесь
-- стоит», а это главный вопрос к сделке в работе. Выводить её из журнала
-- можно, но журнал — не то место, откуда считают рабочие показатели.

alter table deals add column stage_since timestamptz not null default now();

comment on column deals.stage_since is
  'Инвариант 24. Когда сделка вошла в текущий этап. Ставится триггером, вручную не пишется.';

create or replace function app.touch_deal_stage() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.stage_since := now();
  end if;
  return new;
end $$;

comment on function app.touch_deal_stage is
  'Инвариант 24. Дата входа в этап: ставится при смене состояния и только так.';

-- Имя с «a», чтобы дата проставлялась до проверок: они смотрят на состояние,
-- а не на дату.
create trigger a_deal_stage_since
  before update on deals
  for each row execute function app.touch_deal_stage();

-- ---------------------------------------------------------------------------
-- Смена этапа
-- ---------------------------------------------------------------------------
-- Закрытие и срыв сюда не попадают: у них свои функции, потому что у них
-- есть обязательные спутники — финальная цена и причина.

create or replace function set_deal_stage(p_deal_id uuid, p_stage deal_status)
  returns deals
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status deal_status;
  r deals;
begin
  perform app.require_agent();

  if p_stage in ('closed', 'failed') then
    raise exception 'INVARIANT_24: закрытие и срыв — отдельные действия, у них есть обязательные спутники'
      using errcode = 'invalid_parameter_value',
            hint = 'Закрытие требует финальной цены, срыв — причины.';
  end if;

  select status into v_status from deals where id = p_deal_id;
  if v_status is null then
    raise exception 'сделка % не найдена', p_deal_id using errcode = 'no_data_found';
  end if;
  if v_status in ('closed', 'failed') then
    raise exception 'INVARIANT_24: сделка уже завершена, этап ей не поменять'
      using errcode = 'check_violation';
  end if;
  if v_status = p_stage then
    raise exception 'INVARIANT_24: сделка уже на этапе «%»', p_stage
      using errcode = 'invalid_parameter_value';
  end if;

  -- Движение назад разрешено сознательно: на подписании выясняется, что
  -- нужен ещё документ, и сделка возвращается к сбору бумаг. Запрет на
  -- такой возврат заставил бы агента врать системе о том, где он стоит, —
  -- а неправдивый этап хуже отсутствующего.
  update deals set status = p_stage where id = p_deal_id
  returning * into r;

  return r;
end $$;

comment on function set_deal_stage is
  'Инвариант 24. Смена рабочего этапа сделки. Назад тоже можно: иначе агент начнёт врать системе о том, где он стоит.';

-- ---------------------------------------------------------------------------
-- Застрявшие сделки
-- ---------------------------------------------------------------------------
-- Та же мысль, что в отчёте о подвисших объектах: молчание не значит
-- благополучие. Сделка, стоящая на сборе документов третью неделю, — это не
-- «идёт процесс», это повод позвонить.

create or replace function app.deal_stage_days(p_stage deal_status) returns integer
  language sql immutable as $$
  select case p_stage
    -- Задаток внесён — дальше должно двигаться быстро, иначе передумают.
    when 'deposit'    then 7
    -- Сбор документов в Бишкеке дело небыстрое, но не бесконечное.
    when 'documents'  then 21
    when 'signing'    then 7
    when 'settlement' then 7
    -- У завершённых сделок срока нет, и это не забывчивость: на NULL
    -- держится отбор в stuck_deals_v. Поставить сюда число значит начать
    -- показывать закрытые сделки как застрявшие.
    else null
  end
$$;

comment on function app.deal_stage_days is
  'Инвариант 24. Сколько дней этап считается нормальным. Дальше сделка попадает в отчёт.';

create or replace view stuck_deals_v
  with (security_invoker = true) as
select
  d.id                as deal_id,
  d.status,
  d.stage_since,
  (now() - d.stage_since)                              as in_stage,
  extract(day from (now() - d.stage_since))::integer   as days_in_stage,
  app.deal_stage_days(d.status)                        as stage_budget_days,
  o.address,
  o.price,
  o.currency,
  rc.name             as client_name,
  d.listing_agent_id,
  la.full_name        as listing_agent_name,
  d.closing_agent_id,
  ca.full_name        as closing_agent_name,
  (d.listing_agent_id = app.current_agent_id()
   or d.closing_agent_id = app.current_agent_id())     as mine
from deals d
join objects o on o.id = d.object_id
left join requirements r on r.id = d.requirement_id
left join contacts rc on rc.id = r.contact_id
left join agents la on la.id = d.listing_agent_id
left join agents ca on ca.id = d.closing_agent_id
-- Завершённые сделки отсеиваются сами: у закрытой и сорванной срока этапа
-- нет (app.deal_stage_days возвращает NULL), а сравнение с NULL ничего не
-- отбирает. Отдельного «status not in (...)» здесь стояло — мутационный тест
-- показал, что его удаление ничего не меняет. Правило про сроки живёт в
-- одном месте, и это место — deal_stage_days().
where d.stage_since < now() - make_interval(days => app.deal_stage_days(d.status));

comment on view stuck_deals_v is
  'Инвариант 24. Сделки, стоящие на этапе дольше срока. Пустой список — это ответ, а не отсутствие данных.';

grant select on stuck_deals_v to authenticated;
revoke all on stuck_deals_v from anon;

-- ---------------------------------------------------------------------------
-- Этап в списке сделок кабинета
-- ---------------------------------------------------------------------------
-- agent_deals_v собрано в 0027, когда столбца этапа ещё не было. Добавление
-- столбца в середину представления требует его пересоздания: create or
-- replace не меняет порядок и состав колонок.

drop view if exists agent_deals_v;

create view agent_deals_v
  with (security_invoker = true) as
select
  d.id              as deal_id,
  d.status,
  d.stage_since,
  extract(day from (now() - d.stage_since))::integer as days_in_stage,
  app.deal_stage_days(d.status)                      as stage_budget_days,
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
  'Сделки для кабинета с этапом и временем на нём. Доли до закрытия пусты: индикативные суммы живут в deal_commission_v.';

grant select on agent_deals_v to authenticated;
revoke all on agent_deals_v from anon;

revoke execute on function app.on_deal_failed(), app.touch_deal_stage() from public;
revoke execute on function set_deal_stage(uuid, deal_status) from public;
revoke execute on function app.deal_stage_days(deal_status) from public;
grant execute on function set_deal_stage(uuid, deal_status) to authenticated;
grant execute on function app.deal_stage_days(deal_status) to authenticated;
