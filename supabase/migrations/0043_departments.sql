-- 0043_departments.sql
-- ИНВАРИАНТ 34: у агента есть направления и своя работа; у руководителя —
--               всё агентство.
--
-- Из описания работы агентства: «Есть отдел аренды и отдел продажи. Но есть
-- агенты, которые могут вести и аренду, и продажу. Каждый видит только своё
-- или своей организации. Я как руководитель вижу всех и могу включить
-- фильтр, у кого сколько объектов на каких стадиях».
--
-- Отсюда три вещи, которых в модели не было.
--
--   1. НАПРАВЛЕНИЕ. Не роль человека, а набор: агент ведёт аренду, продажу
--      или и то и другое. Поэтому это массив, а не поле «отдел».
--      Направление совпадает с типом сделки, и второй справочник заводить
--      незачем: `deal_type` уже есть.
--
--   2. СВОЯ РАБОТА. Инвариант 33 поставил границу агентства, и этого мало:
--      внутри агентства агент видел работу всех коллег. Теперь он видит ту,
--      в которой участвует.
--
--   3. РУКОВОДИТЕЛЬ. Между агентом и администратором платформы не было
--      никого. Руководитель видит всё своё агентство — и только своё.
--
-- ЧТО УЧАСТИЕ ЗНАЧИТ. Не «мой клиент», а «я в этом работаю»: агент
-- потребности, агент объекта, сторона сделки. Иначе совместная сделка двух
-- агентств (инвариант 33) перестала бы вестись в тот же день.

alter type agent_role add value 'head' before 'admin';

comment on type agent_role is
  'Роль в системе: агент, руководитель агентства, администратор платформы. Руководитель видит всё своё агентство и только его.';

alter table agents add column directions deal_type[] not null default '{sale,rent}';

alter table agents add constraint agents_directions_not_empty
  check (array_length(directions, 1) >= 1);

comment on column agents.directions is
  'Инвариант 34. Направления агента: продажа, аренда или оба. Это набор, а не отдел: агент бывает в двух сразу.';

create index agents_directions_idx on agents using gin (directions);

-- ---------------------------------------------------------------------------
-- Кто что ведёт
-- ---------------------------------------------------------------------------

create or replace function app.is_head() returns boolean
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (select 1 from agents a
                  where a.auth_user_id = auth.uid()
                    and a.status = 'approved'
                    and a.role in ('head', 'admin'))
$$;

comment on function app.is_head is
  'Инвариант 34. Руководитель агентства. Администратор платформы тоже руководитель — иначе ему пришлось бы выдавать себе вторую роль.';

create or replace function app.my_directions() returns deal_type[]
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select a.directions from agents a
   where a.auth_user_id = auth.uid() and a.status = 'approved'
$$;

create or replace function app.in_my_directions(p_deal_type deal_type)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_deal_type = any (coalesce(app.my_directions(), '{}'::deal_type[]))
$$;

comment on function app.in_my_directions is
  'Инвариант 34. Это направление моё. Агент аренды не видит работу по продаже, и наоборот.';

-- Видит ли текущий агент эту работу: сам в ней участвует или он руководитель
-- того агентства, которое её ведёт.
create or replace function app.leads_or_heads(p_agent_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_agent_id = app.current_agent_id()
      or (app.is_head() and app.same_agency(p_agent_id))
$$;

comment on function app.leads_or_heads is
  'Инвариант 34. «Своё» для агента и «всё агентство» для руководителя — одним условием, чтобы правило не разъехалось по политикам.';

revoke execute on function
  app.is_head(), app.my_directions(), app.in_my_directions(deal_type),
  app.leads_or_heads(uuid)
  from public;
grant execute on function
  app.is_head(), app.my_directions(), app.in_my_directions(deal_type),
  app.leads_or_heads(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Инвариант 34: политики
-- ---------------------------------------------------------------------------

drop policy requirements_read on requirements;
create policy requirements_read on requirements for select
  using (app.in_my_directions(deal_type)
         and (app.leads_or_heads(agent_id)
              -- Вторая сторона совместной сделки видит клиента, которого ведёт
              -- чужой агент: без этого сделку не провести (инвариант 33).
              or exists (select 1 from deals d
                          where d.requirement_id = requirements.id
                            and d.status not in ('closed', 'failed')
                            and app.current_agent_id()
                                in (d.listing_agent_id, d.closing_agent_id)))
         or app.is_admin());

drop policy matches_read on matches;
create policy matches_read on matches for select
  using (
    app.leads_or_heads(closing_agent_id)
    -- Агент объекта видит подбор по своему объекту: иначе он не узнает, что
    -- к нему везут покупателя.
    or exists (select 1 from mandates md
                where md.object_id = matches.object_id
                  and md.status = 'active'
                  and app.leads_or_heads(md.listing_agent_id))
    or app.is_admin());

drop policy deals_read on deals;
create policy deals_read on deals for select
  using (app.leads_or_heads(listing_agent_id)
         or app.leads_or_heads(closing_agent_id)
         or app.is_admin());

-- Договор НЕ сужается до «своего». Он принадлежит агентству, а не агенту:
-- коллега обязан видеть, на каком основании объект в базе, иначе он не
-- поймёт, можно ли вести к нему клиента. Первая версия сузила его вместе с
-- остальным, и полный прогон упал на пятнадцати файлах сразу — почти всё,
-- что читает мандат, читает его глазами другого агента.
-- Граница договора — агентство (инвариант 33), и она уже стоит.

drop policy owner_access_read on owner_access;
create policy owner_access_read on owner_access for select
  using (app.leads_or_heads(issued_by_agent_id) or app.is_admin());

-- Настройки рекламы объекта — тоже имущество агентства, а не агента:
-- оставлены на границе инварианта 33.

-- Задачи и обращения уже были личными — к ним добавляется руководитель.
drop policy tasks_read on tasks;
create policy tasks_read on tasks for select
  using (app.leads_or_heads(agent_id)
         or app.leads_or_heads(created_by_agent_id)
         or app.is_admin());

drop policy inquiries_read on inquiries;
create policy inquiries_read on inquiries for select
  using (app.leads_or_heads(received_by_agent_id) or app.is_admin());

-- ---------------------------------------------------------------------------
-- Кто назначает направления и роли
-- ---------------------------------------------------------------------------

create or replace function set_agent_directions(
  p_agent_id uuid,
  p_directions deal_type[]
) returns agents
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r agents;
begin
  perform app.require_agent();

  if not app.is_head() then
    raise exception 'INVARIANT_34: направления агенту назначает руководитель'
      using errcode = '42501';
  end if;

  if not app.same_agency(p_agent_id) and not app.is_admin() then
    raise exception 'INVARIANT_34: агент из чужого агентства вам не подчиняется'
      using errcode = '42501';
  end if;

  if coalesce(array_length(p_directions, 1), 0) = 0 then
    raise exception 'INVARIANT_34: хотя бы одно направление обязательно'
      using errcode = 'check_violation',
            hint = 'Агент без направления не видит ничего: это не настройка, а увольнение.';
  end if;

  update agents set directions = p_directions
   where id = p_agent_id
  returning * into r;

  if r.id is null then
    raise exception 'агент % не найден', p_agent_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function set_agent_directions is
  'Инвариант 34. Направления агента меняет руководитель его агентства. Пустой набор запрещён: это увольнение, а не настройка.';

revoke execute on function set_agent_directions(uuid, deal_type[]) from public;
grant execute on function set_agent_directions(uuid, deal_type[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Сводка руководителя
-- ---------------------------------------------------------------------------
-- «Могу включить фильтр, у кого сколько объектов на каких стадиях» — это
-- отчёт, и он читается под правами смотрящего: у агента в нём будет одна
-- строка, у руководителя — всё агентство.

create or replace view agency_workload_v
  with (security_invoker = true) as
select
  a.id                 as agent_id,
  a.full_name          as agent_name,
  a.directions,
  f.stage,
  count(*)::int        as objects,
  count(*) filter (where f.stuck)::int as stuck
from listing_funnel_v f
join agents a on a.id = f.owner_agent_id
group by a.id, a.full_name, a.directions, f.stage;

comment on view agency_workload_v is
  'Инвариант 34. У кого сколько объектов на каких стадиях. Читается под правами смотрящего: агент видит себя, руководитель — агентство.';

grant select on agency_workload_v to authenticated;
revoke all on agency_workload_v from anon;
