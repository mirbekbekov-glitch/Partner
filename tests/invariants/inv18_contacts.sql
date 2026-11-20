-- Контакты (миграция 0021).
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Один человек — одна запись
-- ===========================================================================
-- Правило из задания. Схема его не держала: проверено, что два контакта с
-- телефоном +996700111222 уживались, а тот же номер в виде «0700 11 12 22»
-- давал третью запись того же человека.

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- Нормализация: четыре записи одного номера сводятся к одной.
select test.eq(app.normalize_phone('+996700111222'), '700111222',
  'международный формат нормализуется');
select test.eq(app.normalize_phone('0700 11 12 22'), '700111222',
  'местный формат с пробелами даёт то же');
select test.eq(app.normalize_phone('+996 (700) 11-12-22'), '700111222',
  'скобки и дефисы не мешают');
select test.eq(app.normalize_phone('700111222'), '700111222',
  'девять цифр остаются как есть');
-- Иностранный номер не ломаем: его план нумерации мы не угадываем.
select test.eq(app.normalize_phone('+7 495 123 45 67'), '74951234567',
  'иностранный номер остаётся цифрами');
select test.eq(app.normalize_phone(null), '', 'пустой ввод даёт пустую норму');

-- Второй контакт на тот же номер невозможен.
insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000d101', 'Орозов Дубль', '{buyer}');

select test.throws(
  $$insert into contact_phones (contact_id, phone)
    values ('00000000-0000-0000-0000-00000000d101', '+996700111222')$$,
  'contact_phones_one_contact_per_phone_idx',
  'второй контакт на тот же номер отклонён');

-- И в другом формате — тоже: иначе уникальность обходится форматированием.
select test.throws(
  $$insert into contact_phones (contact_id, phone)
    values ('00000000-0000-0000-0000-00000000d101', '0700 11 12 22')$$,
  'contact_phones_one_contact_per_phone_idx',
  'и тот же номер в другом формате отклонён');

-- Другой номер этому же контакту — пожалуйста: телефонов у человека много.
insert into contact_phones (contact_id, phone)
values ('00000000-0000-0000-0000-00000000d101', '+996555000111');
select test.eq(
  (select count(*)::int from contact_phones
    where contact_id = '00000000-0000-0000-0000-00000000d101'), 1,
  'второй номер одному контакту добавляется');

-- ===========================================================================
-- Поиск перед созданием
-- ===========================================================================
-- Правило «одна запись» без поиска только наказывает за дубликат, но не
-- помогает его избежать.

select find_contact_by_phone('0700 11 12 22') as f \gset
select test.ok((:'f'::jsonb ->> 'found')::boolean,
  'поиск находит контакт по номеру в любом формате');
select test.ok((:'f'::jsonb ->> 'visible')::boolean,
  'свой контакт виден полностью');
select test.eq(:'f'::jsonb ->> 'name', 'Орозов Собственник',
  'и имя отдаётся');

select find_contact_by_phone('+996999888777') as f2 \gset
select test.ok(not (:'f2'::jsonb ->> 'found')::boolean,
  'незнакомый номер не находится');
reset role;

-- ---- Чужой контакт: факт есть, имени нет -------------------------------
-- Здесь сталкиваются «одна запись» и инвариант 4. Отдаём минимум: что
-- контакт существует и у какого коллеги он, без имени самого контакта.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select find_contact_by_phone('+996700333444') as f3 \gset
select test.ok((:'f3'::jsonb ->> 'found')::boolean,
  'чужой контакт находится: иначе агент заведёт дубликат');
select test.ok(not (:'f3'::jsonb ->> 'visible')::boolean,
  'но помечен как недоступный');
select test.ok((:'f3'::jsonb ->> 'name') is null,
  'имя чужого контакта не отдаётся');
select test.ok((:'f3'::jsonb ->> 'contact_id') is null,
  'и ссылка на него тоже');
select test.eq(:'f3'::jsonb ->> 'owner_name', 'Бакыт',
  'зато названо, с каким коллегой договариваться');
reset role;

-- ===========================================================================
-- Контакт без ролей допустим
-- ===========================================================================
-- Сознательно: «контактное лицо» и «доверенное лицо» — роли СВЯЗИ с
-- объектом, а не контакта. Человек, который всего лишь контактное лицо,
-- ни одной роли контакта не имеет.

set request.jwt.claims = :'claims_aibek';
set role authenticated;
insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000d103', 'Контактное лицо по объекту', '{}');
select test.eq(
  (select array_length(roles, 1) from contacts
    where id = '00000000-0000-0000-0000-00000000d103'),
  null::int, 'контакт без ролей создаётся: это случай из задания');

-- И его можно привязать к объекту контактным лицом.
insert into object_ownerships (object_id, contact_id, role)
values (:'obj1', '00000000-0000-0000-0000-00000000d103', 'contact_person');
select test.eq(
  (select role from object_ownerships
    where object_id = :'obj1'
      and contact_id = '00000000-0000-0000-0000-00000000d103'),
  'contact_person'::ownership_role, 'роль контактного лица живёт на связи');

-- ===========================================================================
-- owner_agent_id по умолчанию свой
-- ===========================================================================

insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000d104', 'Без указания владельца', '{buyer}');
select test.eq(
  (select owner_agent_id from contacts
    where id = '00000000-0000-0000-0000-00000000d104')::text,
  :'agent_aibek'::text, 'владелец контакта подставляется свой');

select test.throws(
  format($$update contacts set owner_agent_id = %L where id = %L$$,
         :'agent_bakyt', '00000000-0000-0000-0000-00000000d104'),
  'permission denied',
  'передать контакт правкой колонки нельзя: только transfer_contact()');

-- ===========================================================================
-- Список контактов и инвариант 4
-- ===========================================================================

select test.ok(test.visible_count($$select 1 from contact_list_v$$) >= 1,
  'свои контакты в списке видны');
select test.eq(
  test.visible_count(format($$select 1 from contact_list_v where id = %L$$,
                            :'contact_client')),
  0::bigint, 'чужой контакт в список не попадает');
select test.eq(
  (select phones from contact_list_v where id = :'contact_owner'),
  '+996700111222', 'телефоны собраны в одну строку');
select test.eq(
  (select objects_count from contact_list_v where id = :'contact_owner'), 3::bigint,
  'посчитаны три объекта собственника');
-- Контактное лицо связано с одним объектом, и это тоже считается.
select test.eq(
  (select objects_count from contact_list_v
    where id = '00000000-0000-0000-0000-00000000d103'), 1::bigint,
  'связь контактным лицом тоже попадает в счёт объектов');
select test.eq(
  (select count(*)::int from contact_objects_v
    where contact_id = :'contact_owner'), 3,
  'объекты контакта перечислены в contact_objects_v');
reset role;

-- Админ видит всех.
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(test.visible_count($$select 1 from contact_list_v$$) >= 2,
  'админ видит все контакты');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from contact_list_v$$, 'permission denied',
  'список контактов анониму недоступен');
select test.throws($$select 1 from contact_objects_v$$, 'permission denied',
  'объекты контакта анониму недоступны');
reset role;
