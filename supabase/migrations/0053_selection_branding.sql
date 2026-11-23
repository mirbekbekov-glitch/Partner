-- 0053_selection_branding.sql
-- Подборка называет, кто её прислал и когда. Пункт P0.6 спецификации,
-- «брендирование».
--
-- НЕ инвариант: ничего не запрещается, добавляется одно поле в страницу,
-- открываемую по секретной ссылке.
--
-- ПОВОД. Подборку печатают и пересылают. На листе, сделанном из неё, не было
-- ни имени агентства, ни даты — документ, который клиент показывает мужу,
-- матери или банку, выглядел ничьим. А подборка недвижимости без даты ещё и
-- опасна: цены стареют, и через месяц тот же лист говорит неправду с тем же
-- уверенным видом. Дата у страницы уже была (`sent_at`), не хватало имени
-- агентства.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Имени и телефона агента: шапка функции запрещает «ни
-- агентов, ни телефонов», и трогать этот запрет в обход владельца продукта не
-- стоит. Вопрос «ставить ли на презентацию контакт отправителя» вынесен
-- отдельно: у него есть обратная сторона — лист с личным номером живёт
-- дольше, чем отношения с клиентом.
--
-- ТЕЛО ФУНКЦИИ ВЗЯТО ИЗ БАЗЫ ДОСЛОВНО, вставлено ровно одно поле. Первая
-- версия этой миграции переписывала функцию заново по памяти — и читала
-- objects и object_photos напрямую вместо public_catalog_v и public_photo_v.
-- Функция security definer, то есть обходит RLS: по секретной ссылке могли бы
-- уехать фотографии неопубликованных объектов. Поймано сверкой с оригиналом,
-- а не глазами.

create or replace function app.selection_page(p_token text)
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
    -- Имя агентства того, кто прислал. НЕ имя агента: шапка функции
    -- запрещает «ни агентов, ни телефонов», и этот запрет не трогается.
    'agency_name', (select ag.name
                      from agents a
                      join agencies ag on ag.id = a.agency_id
                     where a.id = s.agent_id),
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
  'Инвариант 36. Страница подборки по секретной ссылке: варианты, пометки клиента, имя агентства и дата отправки. Ни комиссии, ни агентов, ни телефонов.';
