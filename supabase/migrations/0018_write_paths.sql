-- 0018_write_paths.sql
-- Закрытие обходов прямой записью в таблицы.
--
-- Сквозной разбор слоя доступа показал: почти всем таблицам роль
-- authenticated выдана целиком (INSERT/UPDATE/DELETE на все колонки), а
-- политики ограничивают только НАБОР СТРОК, но не набор колонок. Поэтому
-- правило, записанное в функции, обходилось запросом PATCH прямо в таблицу —
-- PostgREST такой путь отдаёт.
--
-- Что было проверено на схеме до этой миграции:
--
--   A. Сторона сделки переписывала суммы комиссии:
--      update deals set closing_share = 99999, listing_share = 1
--      дало «итого 100000, listing 1, closing 99999».
--   B. Автор подбора ставил closing-агентом СЕБЯ:
--      update matches set closing_agent_id = app.current_agent_id()
--      — тот самый захват комиссии, который 0016 закрыл в функции.
--   C. Потребность уходила в 'in_deal' при нуле сделок.
--   D. Агент привязывал СВОЙ контакт собственником к ЧУЖОМУ объекту.
--   E. Любой агент создавал и снимал каналы публикации чужого объекта.
--
-- Общий вывод: где правило про КОЛОНКУ, его держит поколоночный грант или
-- триггер; политика решает только, какие строки видны и правимы.

-- ===========================================================================
-- A. Сделки: пишутся только функциями
-- ===========================================================================
-- У сделки нет законного пути прямой записи: её создаёт
-- create_deal_from_match(), ведёт set_deal_status(), завершают close_deal()
-- и fail_deal(). Все они SECURITY DEFINER, поэтому снятие гранта их не
-- задевает, а клиенту писать в deals больше нечем.

revoke insert, update, delete on deals from authenticated;

-- И отдельно: суммы комиссии неизменяемы, раз уж записаны. Это защита от
-- будущего неосторожного гранта, а не от текущего состояния.
create or replace function app.guard_deal_money() returns trigger
  language plpgsql as $$
begin
  if (old.commission_total is not null and new.commission_total is distinct from old.commission_total)
     or (old.listing_share is not null and new.listing_share is distinct from old.listing_share)
     or (old.closing_share is not null and new.closing_share is distinct from old.closing_share)
     or (old.final_price is not null and new.final_price is distinct from old.final_price) then
    raise exception
      'INVARIANT_3: суммы закрытой сделки неизменяемы — комиссия фиксируется один раз'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_deal_money
  before update on deals
  for each row execute function app.guard_deal_money();

-- ===========================================================================
-- B. Подбор: closing-агент — это агент потребности, и больше ничей
-- ===========================================================================
-- Правило из 0016 было только в create_match(). Теперь это инвариант данных:
-- кто бы и как ни писал в matches, closing_agent_id равен agent_id
-- потребности. Доля closing-агента (инвариант 3) идёт тому, кто ведёт
-- клиента, и присвоить её себе нечем.

create or replace function app.guard_match_closing_agent() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_req_agent uuid;
begin
  select agent_id into v_req_agent from requirements where id = new.requirement_id;

  if new.closing_agent_id is distinct from v_req_agent then
    raise exception
      'INVARIANT_3: closing-агент подбора — это агент потребности (%), присвоить его нельзя',
      v_req_agent
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_match_closing_agent
  before insert or update of closing_agent_id, requirement_id on matches
  for each row execute function app.guard_match_closing_agent();

-- Структурные поля подбора не правятся: подбор — это пара «объект ×
-- потребность», и подменять пару у существующей строки незачем.
revoke update on matches from authenticated;
grant update (status, rejection_reason, showing_at) on matches to authenticated;

-- ===========================================================================
-- C. Потребность: 'in_deal' означает существующую сделку
-- ===========================================================================
-- То же правило, что для подбора в 0017. Было только в update_requirement().

create or replace function app.check_requirement_in_deal() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'in_deal'
     and not exists (select 1 from deals d
                      where d.requirement_id = new.id and d.status <> 'failed') then
    raise exception
      'INVARIANT_2: статус «в сделке» означает существующую сделку — создайте её из подбора'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'in_deal' and new.status <> 'in_deal'
     and exists (select 1 from deals d
                  where d.requirement_id = new.id
                    and d.status not in ('failed', 'closed')) then
    raise exception
      'INVARIANT_2: по потребности идёт сделка — сначала закройте её или отметьте срыв'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create constraint trigger c_requirement_in_deal_requires_deal
  after insert or update of status on requirements
  deferrable initially immediate
  for each row execute function app.check_requirement_in_deal();

-- ===========================================================================
-- D. Собственность: привязать контакт можно только к своему объекту
-- ===========================================================================
-- Прежде политика проверяла лишь, что контакт принадлежит агенту, а объект
-- не проверяла вовсе — поэтому свой контакт привязывался собственником к
-- чужому объекту.

drop policy ownerships_write  on object_ownerships;
drop policy ownerships_update on object_ownerships;
drop policy ownerships_delete on object_ownerships;

create policy ownerships_write on object_ownerships for insert
  with check (
    app.can_edit_object(object_id)
    and exists (select 1 from contacts c
                 where c.id = contact_id
                   and (c.owner_agent_id = app.current_agent_id() or app.is_admin()))
  );

create policy ownerships_update on object_ownerships for update
  using (app.can_edit_object(object_id) and app.can_see_contact(contact_id))
  with check (app.can_edit_object(object_id) and app.can_see_contact(contact_id));

create policy ownerships_delete on object_ownerships for delete
  using (app.can_edit_object(object_id) and app.can_see_contact(contact_id));

comment on policy ownerships_write on object_ownerships is
  'Связь заводится только на объект, за который агент отвечает, и только своим контактом. Иначе чужому объекту можно подставить собственника.';

-- ===========================================================================
-- E. Каналы публикации: только для своих объектов
-- ===========================================================================
-- Прежде политика пускала любого одобренного агента к каналам любого объекта:
-- можно было подделать external_id и снять чужой объект со всех площадок.

drop policy channels_write on publication_channels;

create policy channels_write on publication_channels for all
  using (app.can_edit_object(object_id))
  with check (app.can_edit_object(object_id));

comment on policy channels_write on publication_channels is
  'Выгрузкой распоряжается тот, кто отвечает за объект: снятие с площадок — такое же действие над чужой работой, как снятие с публикации.';

-- ===========================================================================
-- Мандат: структурные поля не переписываются
-- ===========================================================================
-- Мандат привязан к объекту и к listing-агенту. Переподвязать существующий
-- договор к другому объекту или к другому агенту — это не правка, это подлог.

revoke update on mandates from authenticated;
grant update (kind, valid_from, valid_to, start_price, commission_rule,
              contract_confirmed, document_url, document_hash, status, closed_reason)
  on mandates to authenticated;

-- ===========================================================================
-- Объект: published_at и actual_at ведёт триггер инварианта 5
-- ===========================================================================
-- Триггер их и так переписывает обратно, но грант на запись вводит в
-- заблуждение: попытка выглядит успешной, а значение не меняется.

revoke update on objects from authenticated;
grant update (kind, deal_type, address, zone, rooms, area, floor, floors_total,
              price, currency, photos, description, publication_state, actual_at)
  on objects to authenticated;

-- ===========================================================================
-- Потребность и контакт: владение не передаётся правкой колонки
-- ===========================================================================
-- Передача клиента другому агенту — отдельное действие с журналом, а не
-- тихая правка поля. Пока такого действия нет, колонка закрыта.

revoke update on requirements from authenticated;
grant update (deal_type, budget_min, budget_max, zones, rooms, deadline,
              requirements_text, status, closed_reason)
  on requirements to authenticated;

revoke update on contacts from authenticated;
grant update (kind, name, telegram, source, roles, note) on contacts to authenticated;

-- ===========================================================================
-- Подбор: тип сделки должен совпадать
-- ===========================================================================
-- create_match() это проверяет, прямая вставка — нет. Аренду не подбирают
-- под покупку, и такая строка ломает смысл подбора, а не только отчёты.

create or replace function app.guard_match_deal_type() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v_obj deal_type; v_req deal_type;
begin
  select deal_type into v_obj from objects      where id = new.object_id;
  select deal_type into v_req from requirements where id = new.requirement_id;

  if v_obj is distinct from v_req then
    raise exception 'подбор невозможен: объект это %, потребность это %', v_obj, v_req
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger b_guard_match_deal_type
  before insert or update of object_id, requirement_id on matches
  for each row execute function app.guard_match_deal_type();
