-- ИНВАРИАНТ 36. Подборка — это то, что клиент получил, и переписать его
--               нельзя.
--
--   а. В подборку попадает только то, что клиенту можно показать: объект в
--      каталоге и с действующим договором.
--   б. Пока не отправлена — черновик, состав меняется. После отправки
--      состав неизменен: «клиент видел пять вариантов» не меняется задним
--      числом.
--   в. «Отправлено» и «открыто» — разные факты, и второе не выводится из
--      первого.
--   г. Клиент видит объекты и ничего сверх публичного каталога: ни агента,
--      ни комиссии, ни телефонов.
--   д. Подборку отправляет агент клиента или его руководитель.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_bakyt';

-- ===========================================================================
-- 36а. В подборку попадает только показуемое
-- ===========================================================================

select * from create_selection(:'req1', array[:'obj1'::uuid, :'obj2'::uuid],
                               'Два варианта в центре') \gset sel_
select test.eq(
  (select objects from my_selections_v where id = :'sel_id'), 2,
  'подборка собрана из двух объектов');
select test.eq(
  (select state from my_selections_v where id = :'sel_id'), 'черновик',
  'и пока это черновик');

-- Пустая подборка — не предложение, а повод для вопроса «и что?».
select test.throws(
  format($$select create_selection(%L, '{}'::uuid[])$$, :'req1'),
  'INVARIANT_36',
  'пустую подборку не собрать');

-- Объект вне каталога отправлять нечего: объяснять это пришлось бы агенту.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f5001', 'flat', 'sale', 'Черновик 1', 50000,
        :'agent_bakyt');
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.throws(
  format($$select create_selection(%L, array['00000000-0000-0000-0000-0000000f5001'::uuid])$$,
         :'req2'),
  'не в каталоге',
  'объект вне каталога в подборку не попадает');

-- ===========================================================================
-- 36б. Отправленное не переписывается
-- ===========================================================================

-- Пока черновик — состав меняется свободно.
insert into selection_items (selection_id, object_id, position)
values (:'sel_id', :'obj3', 3);
select test.eq(
  (select objects from my_selections_v where id = :'sel_id'), 3,
  'в черновик объект добавляется');

select test.ok(
  (select sent_at from send_selection(:'sel_id')) is not null,
  'подборка отправлена');

select test.throws(
  format($$delete from selection_items where selection_id = %L and object_id = %L$$,
         :'sel_id', :'obj3'),
  'INVARIANT_36',
  'из отправленной подборки объект не убрать');
select test.throws(
  format($$insert into selection_items (selection_id, object_id, position)
           values (%L, %L, 9)$$, :'sel_id', :'obj3'),
  'INVARIANT_36',
  'и не добавить');
select test.throws(
  format($$update selections set note = 'другое' where id = %L$$, :'sel_id'),
  'INVARIANT_36',
  'и сопроводительное письмо не переписать');

select test.throws(
  format($$select send_selection(%L)$$, :'sel_id'),
  'INVARIANT_36',
  'и второй раз не отправить');

-- ===========================================================================
-- 36в. «Отправлено» — не «открыто»
-- ===========================================================================
-- Система не имеет права утверждать, что клиент прочитал, пока он не
-- открыл. Это разные факты, и на экране они разные слова.

select test.eq(
  (select state from my_selections_v where id = :'sel_id'),
  'отправлена, не открыта',
  'отправленная и неоткрытая — отдельное состояние');
select test.ok(
  (select first_opened_at from my_selections_v where id = :'sel_id') is null,
  'и даты открытия у неё нет');

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(
  app.selection_page(:'sel_token') is not null,
  'клиент открывает подборку по ссылке без входа');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select state from my_selections_v where id = :'sel_id'), 'открыта',
  'и теперь агент видит, что открыта');
select test.ok(
  (select view_count from my_selections_v where id = :'sel_id') > 0,
  'просмотр посчитан');

-- Черновик по ссылке не открывается: клиенту его не отправляли.
select * from create_selection(:'req2', array[:'obj1'::uuid]) \gset draft_
set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(
  app.selection_page(:'draft_token') is null,
  'черновик по ссылке не открывается');

-- Отозванная — тоже.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select revoke_selection(:'sel_id') is not null as revoked \gset
set role anon;
select test.ok(
  app.selection_page(:'sel_token') is null,
  'отозванная подборка не открывается');

-- ===========================================================================
-- 36г. Клиент видит каталог и ничего сверх
-- ===========================================================================

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from create_selection(:'req2', array[:'obj1'::uuid, :'obj2'::uuid]) \gset s2_
select send_selection(:'s2_id') is not null as sent2 \gset

-- Ожидаемое берётся ДО перехода в анонима: ему таблица агентов закрыта, и
-- правильно. Проверка, которая для сравнения лезет туда, куда проверяемому
-- нельзя, — это проверка другой программы.
set role postgres;
set request.jwt.claims = '{}';
select full_name as sender_name, phone as sender_phone
  from agents where id = :'agent_bakyt' \gset
select full_name as lister_name from agents where id = :'agent_aibek' \gset

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select app.selection_page(:'s2_token') as page \gset

-- Проверка точная, а не поиск подстроки.
--
-- Было: «в странице не встречается agent и не встречается +996». Эта форма
-- держалась ровно до миграции 0056, которой владелец продукта разрешил
-- назвать ОТПРАВИТЕЛЯ: как только на странице появился один законный агент и
-- один законный телефон, поиск подстроки пришлось бы просто выбросить — и
-- вместе с ним защиту от чужих.
--
-- Поэтому теперь спрашивается то, что и имелось в виду: комиссии нет вовсе,
-- агент на странице ровно один — отправитель, и телефон ровно один — его же.
-- Листинг-агента объекта здесь быть не должно: в мультилистинге объект ведёт
-- другое агентство.
select test.ok(
  (:'page'::jsonb)::text not like '%commission%'
  and (:'page'::jsonb)::text not like '%комисси%',
  'комиссии в подборке нет');

-- Телефон на странице РОВНО ОДИН и он отправителя. Собираются все номера,
-- какие есть в тексте страницы, и сравниваются с ожидаемым: так проверка не
-- зависит от того, в каком ключе номер лежит, и поймает его появление где
-- угодно — хоть в описании объекта, хоть в пометке клиента.
select test.eq(
  (select coalesce(string_agg(distinct m[1], ', ' order by m[1]), '—')
     from regexp_matches((:'page'::jsonb)::text, '(\+996[0-9]+)', 'g') as m),
  :'sender_phone',
  'телефон на странице ровно один — отправителя');

-- Отправитель назван.
select test.eq(
  ((:'page'::jsonb) -> 'sender' ->> 'agent_name'),
  :'sender_name',
  'отправитель назван по имени');

-- А листинг-агента объекта — нет. obj1 и obj2 ведёт Айбек; в мультилистинге
-- это вообще другое агентство, и называть его клиенту значит отдавать чужую
-- работу вместе с контактом.
select test.ok(
  (:'page'::jsonb)::text not like '%' || :'lister_name' || '%',
  'листинг-агента объекта на странице нет');

-- ---------------------------------------------------------------------------
-- Агент ушёл: номер исчезает, агентство остаётся прежним
-- ---------------------------------------------------------------------------
-- Ради этого контакт и показывается ЖИВЫМ, а не снимком при отправке. Лист с
-- личным номером живёт дольше, чем работа агента в агентстве: мёртвый номер
-- на документе хуже, чем его отсутствие, потому что по нему позвонят.
--
-- А имя агентства, наоборот, снимок: уже отправленный лист не должен менять
-- владельца вслед за переходом агента. Клиент держит в руках документ,
-- которого новое агентство никогда не отправляло.

set role postgres;
set request.jwt.claims = '{}';

select ((:'page'::jsonb) -> 'sender' ->> 'agency_name') as sender_agency \gset

\set agency_other '00000000-0000-0000-0000-00000000ag01'
insert into agencies (id, name, city, status)
values ('00000000-0000-0000-0000-0000000a9001', 'Другое агентство', 'Бишкек', 'active');

update agents set agency_id = '00000000-0000-0000-0000-0000000a9001'
 where id = :'agent_bakyt';

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select app.selection_page(:'s2_token') as gone \gset

select test.eq(
  ((:'gone'::jsonb) -> 'sender' ->> 'agency_name'),
  :'sender_agency',
  'агентство на листе осталось тем, которое прислало');

select test.ok(
  ((:'gone'::jsonb) -> 'sender' ->> 'agent_phone') is null,
  'телефон ушедшего агента со страницы исчез');

select test.ok(
  ((:'gone'::jsonb) -> 'sender' ->> 'agent_name') is null,
  'и имя его тоже: звонить по этому листу больше некому, и лист об этом молчит');

select test.ok(
  (:'gone'::jsonb)::text not like '%+996%',
  'ни одного телефона на странице не осталось');

-- Вернуть на место: ниже в файле Бакыт ещё работает.
set role postgres;
update agents set agency_id = (select agency_id from agents where id = :'agent_aibek')
 where id = :'agent_bakyt';
select test.ok(
  ((:'page'::jsonb) -> 'objects' -> 0 ->> 'address') is not null,
  'а адрес и цена — есть: иначе это не подборка');

-- Объект, снятый с публикации после отправки, со страницы исчезает: клиенту
-- не показывают того, чего уже нет.
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select withdraw_object(:'obj2') is not null as withdrawn \gset

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.eq(
  jsonb_array_length(app.selection_page(:'s2_token') -> 'objects'), 1,
  'снятый с публикации объект со страницы пропал');

-- ===========================================================================
-- 36д. Подборку отправляет агент клиента
-- ===========================================================================

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  test.visible_count(format($$select 1 from selections where id = %L$$, :'s2_id')),
  0::bigint,
  'чужая подборка коллеге не видна');
select test.throws(
  format($$select create_selection(%L, array[%L::uuid])$$, :'req1', :'obj1'),
  'INVARIANT_36',
  'чужому клиенту подборку не отправить');

-- А руководитель может: инвариант 35.
set role postgres;
set request.jwt.claims = '{}';
update agents set role = 'head' where id = :'agent_aibek';
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.ok(
  (select id from create_selection(:'req1', array[:'obj1'::uuid])) is not null,
  'руководитель отправляет подборку за своего агента');

-- ===========================================================================
-- 36е. Реакция клиента — задание на следующий подбор
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select reaction from set_selection_reaction(:'s2_id', :'obj1', 'liked', 'берём этот')),
  'liked',
  'реакция клиента записана');
select test.eq(
  (select liked from my_selections_v where id = :'s2_id'), 1,
  'и посчитана');

-- Реакция появляется ПОСЛЕ отправки и состава не меняет — иначе её вообще
-- нельзя было бы поставить.
select test.eq(
  (select objects from my_selections_v where id = :'s2_id'), 2,
  'состав при этом прежний');

-- ===========================================================================
-- 36ж. Каталогу подборки агентства недоступны
-- ===========================================================================

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(
  not has_table_privilege('anon', 'selections', 'select'),
  'анониму таблица подборок не выдана');
select test.ok(
  not has_table_privilege('anon', 'my_selections_v', 'select'),
  'и представление тоже');
