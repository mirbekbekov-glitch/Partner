-- Запросы страниц кабинета.
--
-- TypeScript не знает схему базы: опечатка в имени колонки компилируется
-- и падает только в рантайме. Здесь перечислены ТЕ ЖЕ списки колонок, что
-- в app/cabinet/**/page.tsx — если колонка исчезнет или переименуется,
-- тест упадёт раньше, чем страница.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
reset role;

-- Посторонний агент: именно его глазами проверяем, что страницы не падают
-- на скрытом контакте.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

-- ---- app/cabinet/objects/[id]/page.tsx -----------------------------------

select test.eq(test.visible_count(format($$
  select id, kind, deal_type, address, zone, rooms, area, floor, price, currency,
         publication_state, published_at, actual_at
    from objects where id = %L$$, :'obj1')),
  1::bigint, 'карточка объекта: список колонок objects существует');

select test.eq(test.visible_count(format($$
  select match_id, object_id, requirement_id, match_status, showing_at,
         rejection_reason, closing_agent_name, deal_type, budget_min, budget_max,
         zones, rooms_wanted, requirement_status, client_name,
         commission_total, listing_share, closing_share, deal_id, deal_status,
         created_at
    from object_matches_v where object_id = %L$$, :'obj1')),
  1::bigint, 'карточка объекта: список колонок object_matches_v существует');

select test.ok(test.visible_count($$
  select id, deal_type, budget_min, budget_max, zones
    from requirements where status not in ('closed','lost')$$) >= 1,
  'карточка объекта: запрос открытых потребностей для кнопки работает');

select test.eq(test.visible_count(format($$
  select id, kind, contract_confirmed, valid_to
    from mandates where object_id = %L and status = 'active'$$, :'obj1')),
  1::bigint, 'карточка объекта: запрос активного мандата работает');

-- ---- app/cabinet/requirements/[id]/page.tsx ------------------------------

select test.eq(test.visible_count(format($$
  select id, contact_id, deal_type, budget_min, budget_max, zones, rooms,
         deadline, requirements_text, status
    from requirements where id = %L$$, :'req1')),
  1::bigint, 'карточка потребности: список колонок requirements существует');

select test.eq(test.visible_count(format($$
  select match_id, requirement_id, object_id, match_status, showing_at,
         rejection_reason, address, zone, rooms, area, floor, price, currency,
         publication_state, actual_at, mandate_id, contract_confirmed,
         listing_agent_name, owner_name, commission_total, listing_share,
         closing_share, deal_id, deal_status, created_at
    from requirement_matches_v where requirement_id = %L$$, :'req1')),
  1::bigint, 'карточка потребности: список колонок requirement_matches_v существует');

select test.ok(test.visible_count($$
  select id, deal_type, address, zone, rooms, price, currency, publication_state
    from objects where publication_state = 'published'$$) >= 1,
  'карточка потребности: запрос опубликованных объектов для кнопки работает');

-- ---- Встроенный контакт (PostgREST: requirements → contacts) -------------
-- Страница тянет contacts(name) вложенным ресурсом. PostgREST отдаёт null,
-- если RLS не пускает, и страница показывает «контакт скрыт». Эквивалент
-- на SQL — LEFT JOIN: он обязан вернуть строку с пустым именем, а не ноль строк.
select test.eq(
  (select c.name from requirements r left join contacts c on c.id = r.contact_id
    where r.id = :'req1'),
  null::text, 'посторонний агент: имя клиента приходит пустым, строка остаётся');
select test.eq(test.visible_count(format($$
  select 1 from requirements r left join contacts c on c.id = r.contact_id
   where r.id = %L$$, :'req1')),
  1::bigint, 'посторонний агент: потребность всё равно отдаётся');
reset role;

-- ---- Тому, кому контакт положен, он приходит -----------------------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  (select c.name from requirements r left join contacts c on c.id = r.contact_id
    where r.id = :'req1'),
  'Жумаев Клиент', 'агент, приведший клиента: имя приходит');
reset role;

-- ---- app/cabinet/admin/agents/page.tsx -----------------------------------
-- Тот же список колонок, что в типе Row на странице одобрения.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(test.visible_count($$
  select id, full_name, email, phone, telegram_id, role, status, created_at,
         objects_count, contacts_count, requirements_count
    from admin_agents_v$$) >= 5,
  'экран одобрения: список колонок admin_agents_v существует');
reset role;

-- ---- app/cabinet/layout.tsx ----------------------------------------------
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(test.visible_count(format($$
  select id, full_name, phone, email, role, status from agents where auth_user_id = %L$$,
  '00000000-0000-0000-0000-0000000000b1')),
  1::bigint, 'гейт кабинета: список колонок своей строки существует');
reset role;

-- Неодобренный агент теперь свою строку ВИДИТ (политика agents_read_self,
-- 0013), поэтому layout различает «ждёт одобрения» и «строки нет» и
-- показывает разные экраны.
set request.jwt.claims = :'claims_pending';
set role authenticated;
select test.eq(test.visible_count(format($$
  select id, full_name, phone, email, role, status from agents where auth_user_id = %L$$,
  '00000000-0000-0000-0000-0000000000b4')),
  1::bigint, 'гейт кабинета: неодобренный агент свою строку видит → экран ожидания с формой имени');

-- ---- app/cabinet/profile/page.tsx ----------------------------------------
select test.eq(test.visible_count(format($$
  select full_name, phone, email, role, status, telegram_id, created_at
    from agents where auth_user_id = %L$$,
  '00000000-0000-0000-0000-0000000000b4')),
  1::bigint, 'профиль: список колонок существует и доступен неодобренному');
reset role;

-- ---- app/cabinet/objects/page.tsx ----------------------------------------
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.ok(test.visible_count($$
  select id, kind, deal_type, address, zone, rooms, area, floor, price, currency,
         publication_state, actual_at, active_mandate_id, contract_confirmed,
         listing_agent_name, owners, matches_count, commission_total
    from object_list_v
   order by actual_at desc$$) >= 3,
  'список объектов: список колонок object_list_v существует');

-- Фильтры страницы: те же выражения, что уходят в PostgREST.
select test.ok(test.visible_count($$
  select 1 from object_list_v where deal_type = 'sale'$$) >= 3,
  'список объектов: фильтр по сделке работает');
select test.ok(test.visible_count($$
  select 1 from object_list_v where publication_state = 'published'$$) >= 1,
  'список объектов: фильтр по состоянию работает');
select test.ok(test.visible_count($$
  select 1 from object_list_v where zone = 'Центр'$$) >= 1,
  'список объектов: фильтр по зоне работает');
select test.ok(test.visible_count($$
  select 1 from object_list_v where address ilike '%Чүй%'$$) >= 1,
  'список объектов: поиск по адресу ilike работает');

-- ---- app/cabinet/requirements/page.tsx -----------------------------------
select test.eq(test.visible_count($$
  select id, deal_type, budget_min, budget_max, zones, rooms, deadline,
         requirements_text, status, agent_name, client_name,
         matches_count, showings_count, deals_count
    from requirement_list_v
   order by updated_at desc$$),
  2::bigint, 'список потребностей: список колонок requirement_list_v существует');

-- contains('zones', [...]) в PostgREST это оператор @> по массиву.
select test.ok(test.visible_count($$
  select 1 from requirement_list_v where zones @> array['Центр']$$) >= 1,
  'список потребностей: фильтр по зоне через @> работает');
select test.ok(test.visible_count($$
  select 1 from requirement_list_v where status = 'qualified'$$) >= 1,
  'список потребностей: фильтр по статусу работает');

-- ---- app/cabinet/page.tsx (счётчики главной) -----------------------------
select test.ok(test.visible_count($$select 1 from objects$$) >= 3,
  'главная: счётчик объектов');
select test.ok(test.visible_count($$
  select 1 from objects where publication_state = 'published'$$) >= 1,
  'главная: счётчик опубликованных');
select test.ok(test.visible_count($$
  select 1 from requirements where status not in ('closed','lost')$$) >= 1,
  'главная: счётчик потребностей в работе');
-- is('active_mandate_id', null) — объекты, которые нельзя опубликовать.
select test.eq(test.visible_count($$
  select 1 from object_list_v where active_mandate_id is null$$),
  0::bigint, 'главная: объектов без мандата сейчас нет');
reset role;

-- ---- app/cabinet/objects/[id]/edit/page.tsx ------------------------------
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(test.visible_count(format($$
  select id, kind, deal_type, address, zone, rooms, area, floor, floors_total,
         price, currency, description, photos
    from objects where id = %L$$, :'obj1')),
  1::bigint, 'правка объекта: список колонок существует');

-- ---- app/cabinet/requirements/[id]/edit/page.tsx -------------------------
select test.eq(test.visible_count(format($$
  select id, deal_type, budget_min, budget_max, zones, rooms, deadline,
         requirements_text, status, closed_reason
    from requirements where id = %L$$, :'req1')),
  1::bigint, 'правка потребности: список колонок существует');
reset role;

-- ---- app/cabinet/deals/page.tsx и [id]/page.tsx --------------------------
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset dm_
select * from create_deal_from_match(:'dm_id') \gset dd_

select test.eq(test.visible_count(format($$
  select id, status, created_at, closed_at, final_price, failure_reason,
         match_id, object_id, requirement_id, mandate_id,
         address, deal_type, zone, rooms, object_price, currency,
         listing_agent_id, listing_agent_name, closing_agent_id, closing_agent_name,
         commission_total, listing_share, closing_share, is_indicative,
         client_name, owners, can_act
    from deal_list_v where id = %L$$, :'dd_id')),
  1::bigint, 'карточка сделки: список колонок deal_list_v существует');

select test.ok(test.visible_count($$
  select 1 from deal_list_v order by created_at desc$$) >= 1,
  'список сделок: сортировка по created_at работает');

-- not('status','in','("closed","failed")') на главной.
select test.ok(test.visible_count($$
  select 1 from deals where status not in ('closed','failed')$$) >= 1,
  'главная: счётчик сделок в работе');
reset role;
