-- ИНВАРИАНТ 7. Каждое изменение сущности пишется в журнал: кто, что, когда.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 7а. Журнал покрывает все содержательные таблицы ---------------------
-- Проверяется наличие триггера, а не память о том, что его навесили.
select test.eq(
  (select count(distinct c.relname)::int
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname like 'zz_audit_%' and not t.tgisinternal),
  13, 'журнальный триггер стоит на всех 13 содержательных таблицах');

-- Заявка с сайта (0028) — такая же сущность: её появление и смена статуса
-- должны быть в журнале наравне с остальными.
select test.ok(
  exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relname = 'leads' and t.tgname = 'zz_audit_leads'
             and not t.tgisinternal),
  'заявки с сайта тоже под журналом');

-- Агентство (0029) — тоже сущность: кто его завёл и кто переименовал,
-- должно быть видно.
select test.ok(
  exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relname = 'organizations' and t.tgname = 'zz_audit_organizations'
             and not t.tgisinternal),
  'агентства тоже под журналом');

-- ---- 7б. Кто, что, когда -------------------------------------------------
-- Чистим журнал от записей сценария приёмки — владельцем таблиц, потому что
-- агенту журнал выдан только на чтение (это проверяется в 7ж).
delete from audit_log where true;

-- И только теперь действуем от имени агента, чтобы в журнале был ОН.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
update objects set price = 88000 where id = :'obj1';
reset role;

select test.eq((select count(*)::int from audit_log where entity_type = 'object'), 1,
  'правка объекта дала ровно одну запись журнала');

select test.eq(
  (select actor_agent_id from audit_log where entity_type = 'object' order by id desc limit 1)::text,
  :'agent_aibek'::text, 'в журнале записан КТО — агент, сделавший правку');

select test.eq(
  (select action from audit_log where entity_type = 'object' order by id desc limit 1),
  'update'::audit_action, 'в журнале записано ЧТО — действие');

select test.ok(
  (select at is not null from audit_log where entity_type = 'object' order by id desc limit 1),
  'в журнале записано КОГДА');

-- ---- 7в. diff содержит только изменившееся -------------------------------
select diff as d from audit_log where entity_type = 'object' order by id desc limit 1 \gset
select test.eq((:'d'::jsonb -> 'price' ->> 'from'), '85000.00',
  'diff хранит прежнее значение цены');
select test.eq((:'d'::jsonb -> 'price' ->> 'to'), '88000.00',
  'diff хранит новое значение цены');
-- actual_at меняется триггером инварианта 5, поэтому он в diff законно.
select test.ok(
  (select bool_and(k in ('price', 'actual_at', 'updated_at'))
     from jsonb_object_keys(:'d'::jsonb) k),
  'diff не тащит неизменившиеся поля');

-- ---- 7г. Вставка и удаление тоже в журнале --------------------------------
delete from audit_log where true;
insert into contacts (id, name, owner_agent_id)
values ('00000000-0000-0000-0000-0000000f7001', 'Журнальный контакт', :'agent_aibek');
select test.eq((select action from audit_log where entity_type = 'contact' order by id desc limit 1),
  'insert'::audit_action, 'вставка попала в журнал');

delete from contacts where id = '00000000-0000-0000-0000-0000000f7001';
select test.eq((select action from audit_log where entity_type = 'contact' order by id desc limit 1),
  'delete'::audit_action, 'удаление попало в журнал');

-- ---- 7д. Пустой UPDATE журнал не засоряет --------------------------------
delete from audit_log where true;
update objects set price = price where id = :'obj2';
select test.eq((select count(*)::int from audit_log where entity_type = 'object'), 0,
  'UPDATE без фактических изменений записи не создаёт');

-- ---- 7е. Таблица с составным ключом тоже журналируется -------------------
delete from audit_log where true;
update object_ownerships set share = 0.5 where object_id = :'obj1';
select test.eq((select count(*)::int from audit_log where entity_type = 'ownership'), 1,
  'object_ownerships журналируется, несмотря на составной ключ');
select test.eq(
  (select entity_id from audit_log where entity_type = 'ownership' order by id desc limit 1)::text,
  :'obj1'::text, 'для составного ключа entity_id это объект, остальное в diff');

-- ---- 7ж. Журнал только читают --------------------------------------------
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  $$insert into audit_log (entity_type, entity_id, action)
    values ('object', gen_random_uuid(), 'update')$$,
  'permission denied',
  'агент не может дописать журнал вручную');
reset role;
