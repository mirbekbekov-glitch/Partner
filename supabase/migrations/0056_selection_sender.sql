-- 0056_selection_sender.sql
-- На презентации названо, КТО её прислал и как с ним связаться.
-- Пункт P0.6, решение владельца продукта.
--
-- ЧТО МЕНЯЕТСЯ В ПРАВИЛЕ. Страница подборки была объявлена так: «ни комиссии,
-- ни агентов, ни телефонов». Запрет снимается ровно с одного — с ОТПРАВИТЕЛЯ.
-- Всё остальное остаётся и становится строже проверенным:
--
--   * листинг-агента чужого агентства на странице нет и не будет. В
--     мультилистинге объект ведёт другое агентство, и называть его клиенту
--     значит отдавать чужую работу;
--   * телефона собственника нет и быть не может — инвариант 4;
--   * комиссии нет.
--
-- ПОЧЕМУ СНИМАЕТСЯ. Лист с подборкой клиент показывает мужу, матери или
-- банку, и первый вопрос у них — «а звонить кому?». Документ без ответа на
-- этот вопрос заставляет клиента искать переписку, в которой пришла ссылка.
-- Имя агентства на это не отвечает: у агентства в нашей модели нет телефона
-- вовсе, есть только у агента.
--
-- ВОЗРАЖЕНИЕ, КОТОРОЕ БЫЛО, И ЧТО С НИМ СДЕЛАНО. Лист с личным номером живёт
-- дольше, чем работа агента в этом агентстве. Поэтому контакт показывается
-- ЖИВЫМ и только пока агент работает в том агентстве, которое прислало
-- подборку. Ушёл — остаётся имя агентства, а номера нет: мёртвый номер на
-- документе хуже, чем его отсутствие, потому что по нему позвонят.

-- ---------------------------------------------------------------------------
-- Чьё агентство прислало
-- ---------------------------------------------------------------------------
-- До сих пор имя агентства бралось ЖИВЫМ от агента. Это неправда с отложенным
-- сроком: агент переходит в другое агентство — и уже отправленная подборка
-- начинает утверждать, что прислало её новое агентство. Клиент при этом
-- держит в руках лист, которого то агентство никогда не отправляло.
--
-- Состав подборки после отправки не меняется по той же причине: «клиент видел
-- пять вариантов» — довод в споре о комиссии. Отправитель — такой же довод, и
-- он фиксируется так же.

alter table selections add column agency_id uuid references agencies(id);

update selections s
   set agency_id = a.agency_id
  from agents a
 where a.id = s.agent_id and s.agency_id is null;

alter table selections alter column agency_id set not null;

comment on column selections.agency_id is
  'Агентство, от имени которого подборка отправлена. Фиксируется при создании: агент может перейти в другое агентство, а отправленный лист менять владельца не должен.';

-- Заполняется триггером, а не только функцией создания: правило должно
-- держаться на любом пути записи, а не на одном, про который мы помним.
create or replace function app.selection_agency() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.agency_id is null then
    select a.agency_id into new.agency_id from agents a where a.id = new.agent_id;
  end if;
  return new;
end $$;

revoke execute on function app.selection_agency() from public;

create trigger a_selection_agency
  before insert on selections
  for each row execute function app.selection_agency();

-- ---------------------------------------------------------------------------
-- Страница клиента
-- ---------------------------------------------------------------------------
-- Тело взято из базы дословно, переписан один ключ.

CREATE OR REPLACE FUNCTION app.selection_page(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- Кто прислал. Агентство — то, от имени которого подборка отправлена
    -- (зафиксировано при создании), а не то, где агент работает сегодня.
    --
    -- Имя и телефон агента показываются ЖИВЫМИ и только пока он работает в
    -- этом же агентстве и одобрен. Ушёл — остаётся агентство: мёртвый номер
    -- на документе хуже, чем его отсутствие, потому что по нему позвонят.
    --
    -- Это ЕДИНСТВЕННЫЙ агент и единственный телефон на странице. Листинг-
    -- агента объекта здесь нет: в мультилистинге объект ведёт другое
    -- агентство, и называть его клиенту значит отдавать чужую работу.
    -- Телефона собственника нет и быть не может — инвариант 4.
    'sender', (select jsonb_build_object(
                 'agency_name', ag.name,
                 'agent_name',
                   case when a.agency_id = s.agency_id and a.status = 'approved'
                        then a.full_name end,
                 'agent_phone',
                   case when a.agency_id = s.agency_id and a.status = 'approved'
                        then a.phone end)
                 from agencies ag
                 left join agents a on a.id = s.agent_id
                where ag.id = s.agency_id),
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
end $function$;

comment on function app.selection_page is
  'Инвариант 36. Страница подборки по секретной ссылке: варианты, пометки клиента и отправитель — агентство, имя и телефон агента. Ни комиссии, ни чужих агентов, ни телефонов собственников.';
