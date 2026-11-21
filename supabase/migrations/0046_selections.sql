-- 0046_selections.sql
-- ИНВАРИАНТ 36: подборка — это то, что клиент получил, и переписать его
--               нельзя.
--
-- «КП отправлено» в рабочей воронке агентства — это подборка объектов,
-- отправленная клиенту. В воронке покупки на этом этапе стоит 33 карточки, в
-- аренде 27. У нас такой сущности не было вовсе: агент отправлял варианты в
-- мессенджере, и система о них не знала ничего.
--
-- ЗАЧЕМ ЭТО СУЩНОСТЬ, А НЕ ОТМЕТКА. Три вопроса, на которые «галочка
-- отправлено» не отвечает:
--
--   ЧТО ИМЕННО отправили. Через неделю «я скидывал варианты» не значит
--   ничего: ни агенту, ни руководителю, ни в споре о том, кто первым показал
--   объект клиенту. Состав подборки — это датированная запись, и в
--   разбирательстве о комиссии она весит больше, чем память.
--
--   ОТКРЫЛ ЛИ. «Отправлено» и «прочитано» — разные факты, и система не имеет
--   права утверждать второе вместо первого. Пока клиент не открыл ссылку, мы
--   знаем ровно одно: мы отправили.
--
--   ЧТО ВЫБРАЛ. Реакция клиента по каждому объекту — готовое задание на
--   следующий подбор. «Золотой вопрос» из разбора рынка звучит именно так:
--   что не подошло в просмотренных вариантах.
--
-- ОТПРАВЛЕННОЕ НЕ ПЕРЕПИСЫВАЕТСЯ. Добавить объект в уже отправленную
-- подборку нельзя: иначе «клиент видел пять вариантов» перестаёт быть
-- правдой задним числом. Передумали — это новая подборка, и их история
-- показывает, как менялось предложение.

create table selections (
  id             uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  agent_id       uuid not null references agents(id) on delete restrict,
  token          text not null unique,
  note           text,

  sent_at        timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,

  -- «Открыл» — отдельный факт, и он не выводится из «отправлено».
  first_opened_at timestamptz,
  last_viewed_at  timestamptz,
  view_count      integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint selections_token_check check (token ~ '^[0-9a-f]{32}$'),
  constraint selections_view_count_check check (view_count >= 0),
  constraint selections_opened_after_sent check (
    first_opened_at is null or sent_at is not null)
);

comment on table selections is
  'Инвариант 36. Подборка объектов, отправленная клиенту. Отправленная не переписывается: что клиент получил, то и получил.';
comment on column selections.first_opened_at is
  'Когда клиент открыл ссылку впервые. NULL означает «не открывал» — и это не то же самое, что «не отправляли».';

create index selections_requirement_idx on selections (requirement_id, created_at desc);
create index selections_agent_idx on selections (agent_id);

create table selection_items (
  selection_id uuid not null references selections(id) on delete cascade,
  object_id    uuid not null references objects(id) on delete restrict,
  position     smallint not null,
  -- Реакция клиента: ставит её агент со слов клиента или сам клиент на
  -- странице подборки.
  reaction     text,
  reacted_at   timestamptz,
  note         text,
  primary key (selection_id, object_id),
  constraint selection_items_position_check check (position >= 1),
  constraint selection_items_reaction_known check (
    reaction is null or reaction in ('liked', 'maybe', 'disliked')),
  constraint selection_items_reaction_dated check (
    (reaction is null) = (reacted_at is null))
);

comment on table selection_items is
  'Инвариант 36. Что именно было в подборке и как клиент на это ответил. Состав отправленной подборки неизменен.';

create unique index selection_items_order_idx
  on selection_items (selection_id, position);

-- ---------------------------------------------------------------------------
-- Инвариант 36: правила подборки
-- ---------------------------------------------------------------------------

create or replace function app.selection_is_sent(p_selection_id uuid)
  returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from selections s
                  where s.id = p_selection_id and s.sent_at is not null)
$$;

create or replace function app.check_selection() returns trigger
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare r requirements%rowtype;
begin
  select * into r from requirements where id = new.requirement_id;
  if not found then
    raise exception 'INVARIANT_36: подборка делается для существующего клиента'
      using errcode = 'foreign_key_violation';
  end if;

  -- Подборку шлёт агент КЛИЕНТА или его руководитель. Чужому клиенту чужие
  -- варианты не отправляют: это и есть увод клиента.
  --
  -- Первая версия сравнивала с new.agent_id — то есть спрашивала «подборку
  -- создаю я?», на что ответ всегда «да». Проверка смотрела не на того
  -- агента, и любой коллега мог отправить варианты чужому клиенту. Поймано
  -- тестом в ту же минуту, как он был написан.
  if auth.uid() is not null
     and r.agent_id is distinct from app.current_agent_id()
     and not app.commands_agent(r.agent_id) then
    raise exception 'INVARIANT_36: подборку клиенту отправляет его агент'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and old.sent_at is not null then
    -- Отправленное можно отозвать и отметить просмотр, но не переписать.
    if new.requirement_id is distinct from old.requirement_id
       or new.agent_id is distinct from old.agent_id
       or new.sent_at is distinct from old.sent_at
       or new.note is distinct from old.note then
      raise exception 'INVARIANT_36: отправленная подборка не переписывается'
        using errcode = '42501',
              hint = 'Передумали — отправьте новую: история подборок показывает, как менялось предложение.';
    end if;
  end if;

  return new;
end $$;

create trigger b_selection_rules
  before insert or update on selections
  for each row execute function app.check_selection();

create trigger a_touch_selections
  before update on selections
  for each row execute function app.touch_updated_at();

create trigger zz_audit_selections
  after insert or update or delete on selections
  for each row execute function app.write_audit('selection', 'id');

create or replace function app.check_selection_item() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_object objects%rowtype;
begin
  -- Состав отправленной подборки неизменен. Реакция клиента — исключение:
  -- она появляется ПОСЛЕ отправки и состава не меняет.
  if app.selection_is_sent(coalesce(new.selection_id, old.selection_id)) then
    if tg_op = 'INSERT' or tg_op = 'DELETE' then
      raise exception 'INVARIANT_36: состав отправленной подборки не меняется'
        using errcode = '42501',
              hint = 'Отправьте новую подборку: «клиент видел пять вариантов» не должно меняться задним числом.';
    end if;
    if new.object_id is distinct from old.object_id
       or new.position is distinct from old.position then
      raise exception 'INVARIANT_36: состав отправленной подборки не меняется'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- В подборку попадает только то, что клиенту можно показать. Иначе агент
  -- отправит варианты, которых нет в каталоге, — и объяснять это придётся
  -- ему, а не системе.
  select * into v_object from objects where id = new.object_id;
  if v_object.publication_state <> 'published' then
    raise exception 'INVARIANT_36: объект «%» не в каталоге, отправлять его нечего',
      v_object.address
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from mandates md
                  where md.object_id = new.object_id and md.status = 'active') then
    raise exception 'INVARIANT_36: у объекта «%» нет действующего договора',
      v_object.address
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger b_selection_item_rules
  before insert or update or delete on selection_items
  for each row execute function app.check_selection_item();

-- ---------------------------------------------------------------------------
-- Слой доступа
-- ---------------------------------------------------------------------------

create or replace function create_selection(
  p_requirement_id uuid,
  p_object_ids     uuid[],
  p_note           text default null
) returns selections
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r       selections;
  v_id    uuid;
  v_pos   smallint := 0;
begin
  if coalesce(array_length(p_object_ids, 1), 0) = 0 then
    raise exception 'INVARIANT_36: в подборке должен быть хотя бы один объект'
      using errcode = 'check_violation',
            hint = 'Пустая подборка — это не предложение, а повод для вопроса «и что?».';
  end if;

  insert into selections (requirement_id, agent_id, token, note)
  values (p_requirement_id, v_agent,
          replace(gen_random_uuid()::text, '-', ''),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning * into r;

  foreach v_id in array p_object_ids loop
    v_pos := v_pos + 1;
    insert into selection_items (selection_id, object_id, position)
    values (r.id, v_id, v_pos)
    on conflict (selection_id, object_id) do nothing;
  end loop;

  return r;
end $$;

comment on function create_selection is
  'Инвариант 36. Собирает подборку. Пока она не отправлена, состав можно менять; после отправки — нет.';

create or replace function send_selection(p_selection_id uuid, p_days integer default 30)
  returns selections
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r selections;
begin
  perform app.require_agent();

  if app.selection_is_sent(p_selection_id) then
    raise exception 'INVARIANT_36: подборка уже отправлена'
      using errcode = '42501';
  end if;

  if not exists (select 1 from selection_items where selection_id = p_selection_id) then
    raise exception 'INVARIANT_36: в подборке должен быть хотя бы один объект'
      using errcode = 'check_violation';
  end if;

  update selections
     set sent_at = now(),
         expires_at = case when p_days is null then null
                           else now() + make_interval(days => p_days) end
   where id = p_selection_id
  returning * into r;

  if r.id is null then
    raise exception 'подборка % не найдена', p_selection_id using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function send_selection is
  'Инвариант 36. Отправляет подборку: с этого момента её состав неизменен, а ссылка работает.';

create or replace function revoke_selection(p_selection_id uuid)
  returns selections
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r selections;
begin
  perform app.require_agent();
  update selections set revoked_at = now()
   where id = p_selection_id and revoked_at is null
  returning * into r;

  if r.id is null then
    raise exception 'подборка % не найдена или уже отозвана', p_selection_id
      using errcode = 'no_data_found';
  end if;
  return r;
end $$;

create or replace function set_selection_reaction(
  p_selection_id uuid,
  p_object_id    uuid,
  p_reaction     text,
  p_note         text default null
) returns selection_items
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r selection_items;
begin
  perform app.require_agent();

  update selection_items
     set reaction = p_reaction,
         reacted_at = case when p_reaction is null then null else now() end,
         note = nullif(btrim(coalesce(p_note, '')), '')
   where selection_id = p_selection_id and object_id = p_object_id
  returning * into r;

  if r.selection_id is null then
    raise exception 'в подборке нет такого объекта' using errcode = 'no_data_found';
  end if;
  return r;
end $$;

comment on function set_selection_reaction is
  'Инвариант 36. Что клиент сказал о варианте. Это и есть задание на следующий подбор.';

-- ---------------------------------------------------------------------------
-- Что видит клиент
-- ---------------------------------------------------------------------------
-- Та же модель, что у отчёта собственнику: страница по секретной ссылке, без
-- входа. И те же запреты — ни комиссии, ни агентов, ни телефонов.

create or replace function app.selection_page(p_token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s      selections%rowtype;
  v_body jsonb;
begin
  select * into s from selections
   where token = p_token
     and sent_at is not null
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  if not found then
    return null;
  end if;

  update selections
     set view_count = view_count + 1,
         last_viewed_at = now(),
         first_opened_at = coalesce(first_opened_at, now())
   where id = s.id;

  select jsonb_build_object(
    'note', s.note,
    'sent_at', s.sent_at,
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id,
               'address', o.address,
               'kind', o.kind,
               'deal_type', o.deal_type,
               'price', o.price,
               'currency', o.currency,
               'rooms', o.rooms,
               'area', o.area,
               'floor', o.floor,
               'floors_total', o.floors_total,
               'zone', o.zone,
               'description', o.description,
               'reaction', si.reaction,
               'photos', coalesce((
                 select jsonb_agg(p.storage_key order by p.sort_order)
                   from public_photo_v p where p.object_id = o.id), '[]'::jsonb))
             order by si.position)
        from selection_items si
        join public_catalog_v o on o.id = si.object_id
       where si.selection_id = s.id), '[]'::jsonb))
  into v_body;

  return v_body;
end $$;

comment on function app.selection_page is
  'Инвариант 36. Подборка глазами клиента: объекты из публичного каталога и ничего сверх него. Ни агента, ни комиссии, ни телефонов — те же правила, что в отчёте собственнику.';

-- Объект, снятый с публикации после отправки, со страницы исчезает: он
-- соединяется с public_catalog_v, а не с objects. Клиенту не показывают то,
-- чего уже нет, — и это правильнее, чем хранить снимок.

create or replace function app.selection_opened(p_token text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select first_opened_at is not null from selections where token = p_token
$$;

-- ---------------------------------------------------------------------------
-- Что видит агент
-- ---------------------------------------------------------------------------

alter table selections enable row level security;
alter table selection_items enable row level security;

create policy selections_read on selections for select
  using (app.leads_or_heads(agent_id) or app.is_admin());
create policy selections_write on selections for insert
  with check (app.leads_or_heads(agent_id) or app.is_admin());
create policy selections_update on selections for update
  using (app.leads_or_heads(agent_id) or app.is_admin());

create policy selection_items_read on selection_items for select
  using (exists (select 1 from selections s
                  where s.id = selection_items.selection_id
                    and (app.leads_or_heads(s.agent_id) or app.is_admin())));
create policy selection_items_write on selection_items for insert
  with check (exists (select 1 from selections s
                       where s.id = selection_items.selection_id
                         and (app.leads_or_heads(s.agent_id) or app.is_admin())));
create policy selection_items_update on selection_items for update
  using (exists (select 1 from selections s
                  where s.id = selection_items.selection_id
                    and (app.leads_or_heads(s.agent_id) or app.is_admin())));
create policy selection_items_delete on selection_items for delete
  using (exists (select 1 from selections s
                  where s.id = selection_items.selection_id
                    and (app.leads_or_heads(s.agent_id) or app.is_admin())));

create or replace view my_selections_v
  with (security_invoker = true) as
select
  s.id,
  s.requirement_id,
  c.name              as client_name,
  s.agent_id,
  a.full_name         as agent_name,
  s.token,
  s.note,
  s.sent_at,
  s.expires_at,
  s.revoked_at,
  s.first_opened_at,
  s.last_viewed_at,
  s.view_count,
  s.created_at,
  case
    when s.revoked_at is not null                       then 'отозвана'
    when s.sent_at is null                              then 'черновик'
    when s.expires_at is not null and s.expires_at < now() then 'срок вышел'
    when s.first_opened_at is null                      then 'отправлена, не открыта'
    else 'открыта'
  end as state,
  (select count(*) from selection_items si where si.selection_id = s.id)::int as objects,
  (select count(*) from selection_items si
    where si.selection_id = s.id and si.reaction = 'liked')::int as liked,
  (select count(*) from selection_items si
    where si.selection_id = s.id and si.reaction = 'disliked')::int as disliked
from selections s
join requirements r on r.id = s.requirement_id
left join contacts c on c.id = r.contact_id
join agents a on a.id = s.agent_id;

comment on view my_selections_v is
  'Инвариант 36. Подборки агента: что отправлено, открыто ли и что клиенту понравилось. «Отправлена, не открыта» — отдельное состояние, а не разновидность отправленной.';

grant select on my_selections_v to authenticated;
revoke all on my_selections_v from anon;

grant select, insert, update, delete on selection_items to authenticated;
grant select, insert, update on selections to authenticated;

revoke execute on function
  app.selection_is_sent(uuid), app.check_selection(), app.check_selection_item(),
  app.selection_page(text), app.selection_opened(text),
  create_selection(uuid, uuid[], text), send_selection(uuid, integer),
  revoke_selection(uuid), set_selection_reaction(uuid, uuid, text, text)
  from public;

grant execute on function
  create_selection(uuid, uuid[], text), send_selection(uuid, integer),
  revoke_selection(uuid), set_selection_reaction(uuid, uuid, text, text)
  to authenticated;

-- Страница подборки открывается клиенту по ссылке — как отчёт собственнику.
grant execute on function app.selection_page(text) to anon;
