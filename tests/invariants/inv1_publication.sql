-- ИНВАРИАНТ 1. Объект публикуется только при активном мандате.
--              У объекта не больше одного активного мандата.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Новый объект без мандата.
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000f001', 'flat', 'sale', 'Без мандата 1', 50000,
        :'agent_aibek');

-- ---- 1а. Публикация без мандата невозможна -------------------------------
-- Пункт приёмки: тест падает, если это удаётся.
select test.throws(
  $$update objects set publication_state = 'published'
     where id = '00000000-0000-0000-0000-00000000f001'$$,
  'INVARIANT_1',
  'прямой UPDATE не публикует объект без мандата');

set request.jwt.claims = :'claims_aibek';
set role authenticated;

select test.throws(
  $$select publish_object('00000000-0000-0000-0000-00000000f001')$$,
  'INVARIANT_1',
  'publish_object() не публикует объект без мандата');

-- Выгрузка в канал — тоже публикация.
select test.throws(
  $$insert into publication_channels (object_id, channel, status)
    values ('00000000-0000-0000-0000-00000000f001', 'lalafo', 'exported')$$,
  'INVARIANT_1',
  'выгрузка в канал без мандата невозможна');

reset role;

-- ---- 1б. С мандатом публикация проходит ----------------------------------
insert into mandates (object_id, start_price, listing_agent_id, status)
values ('00000000-0000-0000-0000-00000000f001', 50000, :'agent_aibek', 'active');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(
  (publish_object('00000000-0000-0000-0000-00000000f001')).publication_state = 'published',
  'с активным мандатом объект публикуется');
reset role;

-- ---- 1в. Второй активный мандат невозможен -------------------------------
select test.throws(
  format($$insert into mandates (object_id, start_price, listing_agent_id, status)
           values (%L, 60000, %L, 'active')$$, :'obj1', :'agent_bakyt'),
  'mandates_one_active_per_object_idx',
  'второй активный мандат на объект отклонён уникальным индексом');

-- Неактивный второй мандат при этом разрешён: история договоров нужна.
insert into mandates (object_id, start_price, listing_agent_id, status)
values (:'obj1', 60000, :'agent_bakyt', 'terminated');
select test.eq(
  (select count(*) from mandates where object_id = :'obj1')::int, 2,
  'расторгнутый мандат сохраняется рядом с активным');

-- ---- 1г. Потеря мандата снимает объект с публикации ----------------------
-- Без этого инвариант держался бы только на входе: истёкший договор оставлял
-- бы объект в каталоге.
insert into publication_channels (object_id, channel, status)
values (:'obj1', 'site', 'exported');

update mandates set status = 'terminated' where id = :'mandate1';

select test.eq(
  (select publication_state from objects where id = :'obj1'), 'withdrawn'::publication_state,
  'расторжение мандата снимает объект с публикации');
select test.eq(
  (select status from publication_channels where object_id = :'obj1' and channel = 'site'),
  'withdrawn'::channel_status,
  'расторжение мандата снимает объект с каналов');

-- ---- 1д. Истечение по дате ------------------------------------------------
select test.throws(
  format($$insert into mandates (object_id, start_price, listing_agent_id, status, valid_to)
           values (%L, 70000, %L, 'active', current_date - 1)$$, :'obj2', :'agent_aibek'),
  'INVARIANT_1',
  'мандат нельзя создать активным с истёкшим сроком');

-- Срок договора закончился на прошлой неделе: valid_from тоже в прошлом,
-- иначе срабатывает check (valid_to >= valid_from).
update mandates set valid_from = current_date - 10, valid_to = current_date - 1
 where object_id = :'obj2' and status = 'active';
select test.eq(app.expire_mandates(), 1, 'app.expire_mandates() закрывает просроченный мандат');
select test.eq(
  (select publication_state from objects where id = :'obj2'), 'withdrawn'::publication_state,
  'истечение мандата по дате снимает объект с публикации');
