-- 0045_head_authority.sql
-- ИНВАРИАНТ 35: руководитель отвечает за всё в своём агентстве — и может всё.
--
-- Решение владельца продукта, дословно: «руководитель может делать все».
--
-- Инвариант 34 дал руководителю видеть всё агентство, но не трогать. Проба
-- показала, чего он не мог: двинуть чужой объект по этапам, заключить по
-- нему договор, подвинуть чужого клиента по воронке, закрыть чужого клиента,
-- закрыть чужую задачу, поправить чужую потребность, передать чужой объект.
-- То есть ровно то, ради чего руководитель и нужен — разобрать за агентом,
-- который уволился, заболел или просто забыл.
--
-- ГРАНИЦА ОСТАЁТСЯ. «Всё» — это всё в СВОЁМ агентстве. Руководитель чужого
-- агентства по-прежнему никто: инвариант 33 не ослабляется, и проверка это
-- подтверждает.
--
-- КАК СДЕЛАНО. Везде, где стояло «или администратор», теперь стоит «или тот,
-- кто над этим человеком начальник». Администратор платформы входит в это
-- условие, поэтому отдельной проверки для него больше не нужно — и это не
-- упрощение ради краткости: два условия об одном расходятся при первой
-- правке (урок «что требует внимания»: одно число — одно место).

create or replace function app.commands_agent(p_agent_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or (p_agent_id is not null
          and app.is_head()
          and app.same_agency(p_agent_id))
$$;

comment on function app.commands_agent is
  'Инвариант 35. Я начальник этого агента: руководитель его агентства или администратор платформы.';

create or replace function app.commands_object(p_object_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or exists (
        select 1 from objects o
         left join mandates md on md.object_id = o.id and md.status = 'active'
         where o.id = p_object_id
           and (app.commands_agent(md.listing_agent_id)
                or app.commands_agent(o.created_by_agent_id)))
$$;

comment on function app.commands_object is
  'Инвариант 35. Я начальник того, кто ведёт этот объект. До договора объект ведёт тот, кто его завёл (инвариант 22), поэтому проверяются оба.';

revoke execute on function
  app.commands_agent(uuid), app.commands_object(uuid) from public;
grant execute on function
  app.commands_agent(uuid), app.commands_object(uuid) to authenticated;


-- app.check_object_editor
CREATE OR REPLACE FUNCTION app.check_object_editor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
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
  if auth.uid() is null or app.commands_object(new.id) then
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
end $function$;

-- public.update_mandate
CREATE OR REPLACE FUNCTION public.update_mandate(p_mandate_id uuid, p_kind mandate_kind, p_valid_to date DEFAULT NULL::date, p_contract_confirmed boolean DEFAULT NULL::boolean)
 RETURNS mandates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_agent uuid := app.require_agent();
  r       mandates;
begin
  if not exists (select 1 from mandates m
                  where m.id = p_mandate_id
                    and (m.listing_agent_id = v_agent
                         or app.commands_agent(m.listing_agent_id))) then
    raise exception 'INVARIANT_22: условия договора меняет его владелец'
      using errcode = '42501';
  end if;

  update mandates
     set kind               = p_kind,
         valid_to           = p_valid_to,
         contract_confirmed = coalesce(p_contract_confirmed, contract_confirmed)
   where id = p_mandate_id
  returning * into r;

  return r;
end $function$;

-- public.update_requirement
CREATE OR REPLACE FUNCTION public.update_requirement(p_requirement_id uuid, p_budget_min numeric DEFAULT NULL::numeric, p_budget_max numeric DEFAULT NULL::numeric, p_zones text[] DEFAULT '{}'::text[], p_rooms smallint[] DEFAULT '{}'::smallint[], p_deadline date DEFAULT NULL::date, p_text text DEFAULT NULL::text)
 RETURNS requirements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_agent uuid := app.require_agent();
  r       requirements;
begin
  if not exists (select 1 from requirements rq
                  where rq.id = p_requirement_id
                    and (rq.agent_id = v_agent
                         or app.commands_agent(rq.agent_id))) then
    raise exception 'INVARIANT_22: потребность правит её агент'
      using errcode = '42501';
  end if;

  update requirements
     set budget_min        = p_budget_min,
         budget_max        = p_budget_max,
         zones             = coalesce(p_zones, '{}'),
         rooms             = coalesce(p_rooms, '{}'),
         deadline          = p_deadline,
         requirements_text = nullif(btrim(coalesce(p_text, '')), '')
   where id = p_requirement_id
  returning * into r;

  return r;
end $function$;

-- public.update_contact
CREATE OR REPLACE FUNCTION public.update_contact(p_contact_id uuid, p_name text, p_phone text DEFAULT NULL::text)
 RETURNS contacts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_agent uuid := app.require_agent();
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  r       contacts;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'имя обязательно' using errcode = 'check_violation';
  end if;

  if not app.can_see_contact(p_contact_id) then
    raise exception 'FORBIDDEN: этот контакт вам не виден'
      using errcode = '42501';
  end if;

  if not exists (select 1 from contacts c
                  where c.id = p_contact_id
                    and (c.owner_agent_id = v_agent
                         or app.commands_agent(c.owner_agent_id))) then
    raise exception 'INVARIANT_22: контакт правит агент, который его ведёт'
      using errcode = '42501';
  end if;

  update contacts set name = btrim(p_name) where id = p_contact_id
  returning * into r;

  if v_phone is not null then
    -- Основной телефон один: правка меняет его, а не добавляет второй.
    if exists (select 1 from contact_phones cp
                where cp.contact_id = p_contact_id and cp.is_primary) then
      update contact_phones set phone = v_phone
       where contact_id = p_contact_id and is_primary;
    else
      insert into contact_phones (contact_id, phone, is_primary)
      values (p_contact_id, v_phone, true);
    end if;
  end if;

  return r;
end $function$;

-- app.check_requirement_funnel
CREATE OR REPLACE FUNCTION app.check_requirement_funnel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
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
     and not app.commands_agent(new.agent_id)
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
end $function$;

-- app.check_task
CREATE OR REPLACE FUNCTION app.check_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare v_me uuid;
begin
  new.title := btrim(new.title);

  -- Исполнитель — одобренный агент, а не любая строка в таблице агентов.
  if not exists (select 1 from agents a
                  where a.id = new.agent_id and a.status = 'approved') then
    raise exception 'INVARIANT_31: исполнитель задачи — одобренный агент'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.done_at is not null or new.cancelled_at is not null then
      raise exception 'INVARIANT_31: задача заводится открытой'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Закрытая задача окончательна. Передумали — заводится новая: иначе
  -- «сделано вчера» переписывается задним числом, и журнал звонков
  -- перестаёт быть журналом.
  if old.done_at is not null or old.cancelled_at is not null then
    raise exception 'INVARIANT_31: закрытая задача не меняется'
      using errcode = '42501',
            hint = 'Нужна ещё одна — заведите новую.';
  end if;

  -- Правит исполнитель, постановщик или администратор. Проверка в триггере,
  -- а не только в политике: функции задач security definer, и политика в них
  -- не работает (урок инвариантов 28 и 30).
  --
  -- Исключение одно и оно фактическое: задачу о закрытом предмете гасит сам
  -- предмет, и кто в этот момент нажал кнопку — неважно.
  v_me := app.current_agent_id();
  if auth.uid() is not null
     and not app.commands_agent(old.agent_id)
     and v_me is distinct from old.agent_id
     and v_me is distinct from old.created_by_agent_id
     and not (new.cancelled_at is not null
              and app.task_subject_closed(new.requirement_id, new.deal_id, new.inquiry_id))
  then
    raise exception 'INVARIANT_31: задачу ведёт её исполнитель или тот, кто её поставил'
      using errcode = '42501';
  end if;

  return new;
end $function$;

-- public.sign_mandate
CREATE OR REPLACE FUNCTION public.sign_mandate(p_object_id uuid, p_kind mandate_kind DEFAULT 'non_exclusive'::mandate_kind, p_valid_to date DEFAULT NULL::date, p_start_price numeric DEFAULT NULL::numeric, p_confirmed boolean DEFAULT false)
 RETURNS mandates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_agent uuid := app.require_agent();
  o       objects%rowtype;
  r       mandates;
begin
  select * into o from objects where id = p_object_id;
  if not found then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  -- Договор заключает тот, кто ведёт объект. Для объекта без договора это
  -- тот, кто его завёл (инвариант 22), и администратор.
  if auth.uid() is not null
     and not app.commands_object(p_object_id)
     and o.created_by_agent_id is distinct from v_agent
     and not app.is_listing_agent(p_object_id) then
    raise exception 'INVARIANT_32: договор заключает агент, который ведёт объект'
      using errcode = '42501';
  end if;

  -- Договор нужен объекту, у которого собственник известен: иначе непонятно,
  -- с кем он заключён.
  if not exists (select 1 from object_ownerships oo
                  where oo.object_id = p_object_id
                    and oo.role in ('owner', 'co_owner', 'proxy')) then
    raise exception 'INVARIANT_32: у объекта нет собственника, договор заключать не с кем'
      using errcode = 'check_violation';
  end if;

  insert into mandates (object_id, kind, valid_to, start_price,
                        listing_agent_id, contract_confirmed, status)
  values (p_object_id, p_kind, p_valid_to,
          coalesce(p_start_price, o.price), v_agent, p_confirmed, 'active')
  returning * into r;

  return r;
end $function$;

-- public.confirm_mandate
CREATE OR REPLACE FUNCTION public.confirm_mandate(p_object_id uuid)
 RETURNS mandates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r mandates;
begin
  perform app.require_agent();

  if not app.is_listing_agent(p_object_id)
     and not app.commands_object(p_object_id) then
    raise exception 'INVARIANT_32: договор подтверждает агент этого договора'
      using errcode = '42501';
  end if;

  update mandates set contract_confirmed = true
   where object_id = p_object_id and status = 'active'
  returning * into r;

  if r.id is null then
    raise exception 'INVARIANT_32: у объекта нет действующего договора'
      using errcode = 'no_data_found';
  end if;
  return r;
end $function$;

-- public.pause_showings
CREATE OR REPLACE FUNCTION public.pause_showings(p_object_id uuid, p_reason text)
 RETURNS objects
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform app.require_agent();
  if not app.is_listing_agent(p_object_id)
     and not app.commands_object(p_object_id) then
    raise exception 'INVARIANT_29: приостанавливает показы агент действующего договора'
      using errcode = '42501';
  end if;
  return app.set_pause(p_object_id, true, p_reason,
                       case when app.is_admin() then 'admin' else 'agent' end::pause_author);
end $function$;

-- public.resume_showings
CREATE OR REPLACE FUNCTION public.resume_showings(p_object_id uuid)
 RETURNS objects
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform app.require_agent();
  if not app.is_listing_agent(p_object_id)
     and not app.commands_object(p_object_id) then
    raise exception 'INVARIANT_29: возобновляет показы агент действующего договора'
      using errcode = '42501';
  end if;
  return app.set_pause(p_object_id, false, null,
                       case when app.is_admin() then 'admin' else 'agent' end::pause_author);
end $function$;

-- public.transfer_object
CREATE OR REPLACE FUNCTION public.transfer_object(p_object_id uuid, p_to_agent uuid)
 RETURNS mandates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me      uuid := app.require_agent();
  v_mandate mandates;
  r         mandates;
begin
  select * into v_mandate from mandates
   where object_id = p_object_id and status = 'active';

  if v_mandate.id is null then
    raise exception 'INVARIANT_23: у объекта нет действующего договора, передавать нечего'
      using errcode = 'no_data_found',
            hint = 'Объект без договора ведёт тот, кто его завёл.';
  end if;

  if v_mandate.listing_agent_id <> v_me
     and not app.commands_agent(v_mandate.listing_agent_id) then
    raise exception 'INVARIANT_23: объект передаёт тот, кто его ведёт, или администратор'
      using errcode = '42501';
  end if;

  perform app.check_transfer_target(p_to_agent);

  update mandates set listing_agent_id = p_to_agent
   where id = v_mandate.id
  returning * into r;

  -- Незакрытая работа переходит вместе с объектом: комиссия по таким сделкам
  -- ещё не зафиксирована, и получит её тот, кто доведёт дело до конца.
  -- Закрытые и сорванные не трогаем — там уже сказано, кому заплачено.
  update deals set listing_agent_id = p_to_agent
   where mandate_id = v_mandate.id
     and status not in ('closed', 'failed');

  return r;
end $function$;

-- public.transfer_requirement
CREATE OR REPLACE FUNCTION public.transfer_requirement(p_requirement_id uuid, p_to_agent uuid)
 RETURNS requirements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me  uuid := app.require_agent();
  v_req requirements;
  r     requirements;
begin
  select * into v_req from requirements where id = p_requirement_id;

  if v_req.id is null then
    raise exception 'потребность % не найдена', p_requirement_id
      using errcode = 'no_data_found';
  end if;

  if v_req.agent_id <> v_me
     and not app.commands_agent(v_req.agent_id) then
    raise exception 'INVARIANT_23: клиента передаёт тот, кто его ведёт, или администратор'
      using errcode = '42501';
  end if;

  perform app.check_transfer_target(p_to_agent);

  update requirements set agent_id = p_to_agent
   where id = p_requirement_id
  returning * into r;

  -- Подборы клиента переходят вместе с ним: иначе инвариант 20 оставит
  -- прежнего агента закрывающей стороной, и работать по ним новый не сможет.
  --
  -- Кроме тех, за которыми стоит закрытая или сорванная сделка. Такой подбор
  -- — история: сделка по нему уже записала, кто её вёл и кому заплачено, и
  -- переписывать подбор значит расходиться с этой записью. Первая версия
  -- двигала все подборы подряд.
  update matches mt set closing_agent_id = p_to_agent
   where mt.requirement_id = p_requirement_id
     and not exists (select 1 from deals d
                      where d.match_id = mt.id
                        and d.status in ('closed', 'failed'));

  update deals set closing_agent_id = p_to_agent
   where requirement_id = p_requirement_id
     and status not in ('closed', 'failed');

  return r;
end $function$;

-- app.can_move_showing
CREATE OR REPLACE FUNCTION app.can_move_showing(p_match_id uuid, p_agent_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
  select app.commands_agent(p_agent_id)
      or app.current_agent_id() = p_agent_id
      or app.is_match_participant(p_match_id, app.current_agent_id())
$function$;

-- public.publish_object
CREATE OR REPLACE FUNCTION public.publish_object(p_object_id uuid)
 RETURNS objects
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r objects;
begin
  perform app.require_agent();

  -- Сначала договор, потом агент: без мандата публиковать нельзя никому, и
  -- это объясняет положение дел лучше, чем «не ваш объект».
  if app.active_mandate_id(p_object_id) is null then
    raise exception
      'INVARIANT_1: объект нельзя опубликовать без активного мандата'
      using errcode = 'check_violation',
            hint = 'Заключите мандат с собственником, затем публикуйте.';
  end if;

  if not app.is_listing_agent(p_object_id)
     and not app.commands_object(p_object_id) then
    raise exception 'INVARIANT_22: публикует объект агент действующего договора'
      using errcode = '42501';
  end if;

  update objects set publication_state = 'published'
   where id = p_object_id
  returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;
  return r;
end $function$;

-- public.withdraw_object
CREATE OR REPLACE FUNCTION public.withdraw_object(p_object_id uuid)
 RETURNS objects
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r objects;
begin
  perform app.require_agent();

  if not app.is_listing_agent(p_object_id)
     and not app.commands_object(p_object_id) then
    raise exception 'INVARIANT_22: снимает объект агент действующего договора'
      using errcode = '42501';
  end if;

  update objects set publication_state = 'withdrawn'
   where id = p_object_id returning * into r;

  if r.id is null then
    raise exception 'объект % не найден', p_object_id using errcode = 'no_data_found';
  end if;

  return r;
end $function$;
