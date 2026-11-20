-- Объединение дубликатов контактов (миграция 0022).
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Два дубликата одного человека с РАЗНЫМИ номерами: именно так дубликат и
-- попадает в базу после 0021 — одинаковые номера она уже не пускает.
set request.jwt.claims = :'claims_aibek';
set role authenticated;

insert into contacts (id, name, roles, telegram, note)
values ('00000000-0000-0000-0000-00000000e101', 'Орозов Нурлан', '{owner}',
        '@orozov', 'предпочитает звонки утром');
insert into contact_phones (contact_id, phone, is_primary)
values ('00000000-0000-0000-0000-00000000e101', '+996700777111', true);

insert into contacts (id, name, roles, source, note)
values ('00000000-0000-0000-0000-00000000e102', 'орозов  нурлан', '{buyer,tenant}',
        'lalafo', 'ищет двушку');
insert into contact_phones (contact_id, phone, is_primary)
values ('00000000-0000-0000-0000-00000000e102', '+996555777222', true);

-- Обе записи связаны с объектами и потребностями, которые нельзя потерять.
insert into object_ownerships (object_id, contact_id, role)
values (:'obj1', '00000000-0000-0000-0000-00000000e101', 'co_owner');

-- У присоединяемой записи две связи, и они проверяют разные пути:
--   obj3 — своя, её надо перенести;
--   obj2 — та же роль по тому же объекту, что у остающейся записи, и она
--   упёрлась бы в составной ключ object_ownerships_pkey.
insert into object_ownerships (object_id, contact_id, role)
values (:'obj3', '00000000-0000-0000-0000-00000000e102', 'co_owner'),
       (:'obj2', '00000000-0000-0000-0000-00000000e101', 'co_owner'),
       (:'obj2', '00000000-0000-0000-0000-00000000e102', 'co_owner');

insert into requirements (id, contact_id, deal_type, budget_max, agent_id, status)
values ('00000000-0000-0000-0000-00000000e9a1', '00000000-0000-0000-0000-00000000e102',
        'sale', 95000, :'agent_aibek', 'qualified');
insert into activities (kind, entity_type, entity_id, body)
values ('note', 'contact', '00000000-0000-0000-0000-00000000e102', 'звонил, перезвонит');

-- ===========================================================================
-- Кандидаты в дубликаты находятся
-- ===========================================================================

select test.ok(
  (select count(*) > 0 from contact_duplicates_v
    where id = '00000000-0000-0000-0000-00000000e101'
      and other_id = '00000000-0000-0000-0000-00000000e102'),
  'пара найдена по имени, несмотря на разный регистр и двойной пробел');

-- ===========================================================================
-- Объединение
-- ===========================================================================

select merge_contacts('00000000-0000-0000-0000-00000000e101',
                      '00000000-0000-0000-0000-00000000e102') as m \gset

select test.eq((:'m'::jsonb ->> 'phones')::int, 1, 'телефон перенесён');
select test.eq((:'m'::jsonb ->> 'requirements')::int, 1, 'потребность перенесена');
select test.eq((:'m'::jsonb ->> 'activities')::int, 1, 'активность перенесена');
select test.eq((:'m'::jsonb ->> 'ownerships')::int, 1, 'непротиворечивая связь перенесена');
select test.eq((:'m'::jsonb ->> 'ownerships_dropped')::int, 1,
  'дублирующая связь по одному объекту в одной роли убрана');
reset role;

-- ---- Ничего не потеряно -------------------------------------------------
-- Главная проверка: requirements ссылается на контакт с ON DELETE CASCADE,
-- и удаление лишней записи раньше переноса УНИЧТОЖИЛО бы потребность.
select test.eq(
  (select contact_id from requirements where id = '00000000-0000-0000-0000-00000000e9a1')::text,
  '00000000-0000-0000-0000-00000000e101',
  'потребность НЕ удалена каскадом, а переехала');
select test.eq(
  (select count(*)::int from contact_phones
    where contact_id = '00000000-0000-0000-0000-00000000e101'), 2,
  'у остающейся записи оба телефона');
select test.eq(
  (select count(*)::int from activities
    where entity_type = 'contact' and entity_id = '00000000-0000-0000-0000-00000000e101'), 1,
  'активность привязана к остающейся записи');

select test.eq(
  (select count(*)::int from object_ownerships
    where object_id = :'obj3'
      and contact_id = '00000000-0000-0000-0000-00000000e101'), 1,
  'своя связь присоединённой записи переехала на остающуюся');
select test.eq(
  (select count(*)::int from object_ownerships where object_id = :'obj2'
     and role = 'co_owner'), 1,
  'по общему объекту осталась одна связь, а не две одинаковых');

-- ---- Один основной номер ------------------------------------------------
select test.eq(
  (select count(*)::int from contact_phones
    where contact_id = '00000000-0000-0000-0000-00000000e101' and is_primary), 1,
  'основной номер остался ровно один');

-- ---- Роли объединены ----------------------------------------------------
-- В этом и смысл правила: роли это флаги ОДНОЙ записи.
select test.eq(
  (select array_length(roles, 1) from contacts
    where id = '00000000-0000-0000-0000-00000000e101'), 3,
  'роли объединены: собственник, покупатель, арендатор');
select test.ok(
  (select roles @> '{owner,buyer,tenant}'::contact_role[] from contacts
    where id = '00000000-0000-0000-0000-00000000e101'),
  'все три роли на месте');

-- ---- Поля заполнены, заметки склеены ------------------------------------
select test.eq(
  (select source from contacts where id = '00000000-0000-0000-0000-00000000e101'),
  'lalafo', 'пустое поле заполнено из присоединённой записи');
select test.eq(
  (select telegram from contacts where id = '00000000-0000-0000-0000-00000000e101'),
  '@orozov', 'заполненное поле не затёрто');
select test.ok(
  (select note like '%утром%' and note like '%двушку%' from contacts
    where id = '00000000-0000-0000-0000-00000000e101'),
  'заметки склеены, написанное человеком не потеряно');

-- ---- Лишняя запись удалена ----------------------------------------------
select test.eq(
  (select count(*)::int from contacts where id = '00000000-0000-0000-0000-00000000e102'), 0,
  'присоединённая запись удалена');
select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'contact'
      and entity_id = '00000000-0000-0000-0000-00000000e102'
      and action = 'delete'),
  'удаление записано в журнал: что в ней было, восстановимо');

-- ===========================================================================
-- Запись БЕЗ связей с объектами: здесь порядок шагов больше ничем не прикрыт
-- ===========================================================================
-- Выше неправильный порядок упёрся бы в RESTRICT на object_ownerships — то
-- есть был бы поймán случайно. Если связей с объектами нет, RESTRICT молчит,
-- и удаление раньше переноса ТИХО уничтожило бы потребности и телефоны
-- каскадом. Этот случай проверяет порядок сам по себе.

set request.jwt.claims = :'claims_aibek';
set role authenticated;

insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000e201', 'Асанов Эрмек', '{buyer}');
insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000e202', 'асанов эрмек', '{tenant}');
insert into contact_phones (contact_id, phone, is_primary)
values ('00000000-0000-0000-0000-00000000e202', '+996700888999', true);
insert into requirements (id, contact_id, deal_type, budget_max, agent_id, status)
values ('00000000-0000-0000-0000-00000000e9b1', '00000000-0000-0000-0000-00000000e202',
        'rent', 700, :'agent_aibek', 'new');

select test.eq(
  (select count(*)::int from object_ownerships
    where contact_id = '00000000-0000-0000-0000-00000000e202'), 0,
  'у присоединяемой записи нет связей с объектами: RESTRICT не прикроет');

select merge_contacts('00000000-0000-0000-0000-00000000e201',
                      '00000000-0000-0000-0000-00000000e202') as m2 \gset
reset role;

select test.eq((:'m2'::jsonb ->> 'requirements')::int, 1,
  'потребность перенесена, а не уничтожена каскадом');
select test.eq(
  (select contact_id from requirements where id = '00000000-0000-0000-0000-00000000e9b1')::text,
  '00000000-0000-0000-0000-00000000e201',
  'потребность на месте и указывает на остающуюся запись');
select test.eq(
  (select count(*)::int from contact_phones
    where contact_id = '00000000-0000-0000-0000-00000000e201'), 1,
  'телефон перенесён, а не удалён каскадом');
select test.eq(
  (select count(*)::int from requirements
    where id = '00000000-0000-0000-0000-00000000e9b1'), 1,
  'потребность существует: каскад её не съел');

-- ===========================================================================
-- Объединять можно только свои записи
-- ===========================================================================
-- Иначе объединение становится способом забрать чужого клиента.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000e103', 'Жумаев Клиент', '{buyer}');

select test.throws(
  format($$select merge_contacts('00000000-0000-0000-0000-00000000e103', %L)$$,
         :'contact_client'),
  'объединять можно свои записи',
  'чужую запись к своей не присоединить');
select test.throws(
  format($$select merge_contacts(%L, '00000000-0000-0000-0000-00000000e103')$$,
         :'contact_client'),
  'объединять можно свои записи',
  'и свою к чужой тоже');
reset role;

select test.eq((select count(*)::int from contacts where id = :'contact_client'), 1,
  'чужой контакт на месте');
select test.eq(
  (select owner_agent_id from contacts where id = :'contact_client')::text,
  :'agent_bakyt'::text, 'и остался у своего агента');

-- Админ склеивает что угодно.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(
  merge_contacts(:'contact_client', '00000000-0000-0000-0000-00000000e103') is not null,
  'админ объединяет записи разных агентов');
reset role;

-- ===========================================================================
-- Края
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  format($$select merge_contacts(%L, %L)$$, :'contact_owner', :'contact_owner'),
  'одна и та же запись',
  'объединить запись с собой нельзя');
select test.throws(
  format($$select merge_contacts(%L, gen_random_uuid())$$, :'contact_owner'),
  'не найден',
  'несуществующая запись отклонена');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from contact_duplicates_v$$, 'permission denied',
  'список дубликатов анониму недоступен');
reset role;
