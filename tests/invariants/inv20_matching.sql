-- ИНВАРИАНТ 20. Агент подбора — это агент потребности, он не назначается
--               запросом; объект без действующего договора клиенту не
--               предлагают.
--
-- Обе половины найдены запросом, а не рассуждением, и обе были дырами:
-- Чынгыз завёл подбор по клиенту Бакыта и стал по нему агентом подбора,
-- а объект с расторгнутым договором предложился клиенту как ни в чём не
-- бывало. Доля агента покупателя по инварианту 3 считается именно по
-- closing_agent_id — то есть первая дыра была про чужие деньги.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 20а. Агент подбора выводится, а не принимается ------------------------
-- Поле, которое нельзя передать неправильно, надёжнее поля, которое
-- проверяется. Поэтому closing_agent_id берётся из потребности даже тогда,
-- когда в запросе пришло другое.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select id as m1 from create_match(:'obj1', :'req1') \gset
select test.eq(
  (select closing_agent_id from matches where id = :'m1'),
  :'agent_bakyt'::uuid,
  'агент подбора — агент потребности');

set role postgres;
insert into matches (object_id, requirement_id, closing_agent_id, created_by_agent_id)
values (:'obj3', :'req2', :'agent_chyngyz', :'agent_chyngyz');
select test.eq(
  (select closing_agent_id from matches where object_id = :'obj3' and requirement_id = :'req2'),
  :'agent_bakyt'::uuid,
  'подложенный в запросе агент подбора не принимается даже при прямой вставке');

-- ---- 20б. По чужой потребности подбор не ведут -----------------------------
set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select create_match(%L, %L)$$, :'obj2', :'req1'),
  'INVARIANT_20: подбор по потребности ведёт её агент',
  'по чужой потребности подбор не завести');

-- И прямой вставкой тоже: роли приложения выдан insert на matches, поэтому
-- правило, живущее только в функции, обходится в одну строку.
select test.throws(
  format($$insert into matches (object_id, requirement_id, created_by_agent_id)
           values (%L, %L, app.current_agent_id())$$, :'obj2', :'req1'),
  'INVARIANT_20: подбор по потребности ведёт её агент',
  'и прямой вставкой тоже не завести');

-- ---- 20в. Объект без договора клиенту не предлагают ------------------------
-- Тот же инвариант 1, но с другой стороны: в каталог такой объект не
-- попадёт, а показать его клиенту лично никто не мешал.
set role postgres;
update mandates set status = 'terminated' where object_id = :'obj2';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select create_match(%L, %L)$$, :'obj2', :'req1'),
  'INVARIANT_20: у объекта нет действующего договора',
  'объект с расторгнутым договором не предложить');

-- ---- 20г. Снятый с публикации, но с договором — предлагать можно -----------
-- Правило про договор, а не про витрину: эксклюзив часто не рекламируют,
-- а показывают.
set role postgres;
update mandates set status = 'active' where object_id = :'obj2';
update objects  set publication_state = 'withdrawn' where id = :'obj2';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.ok(
  (select count(*) from create_match(:'obj2', :'req1')) = 1,
  'объект вне каталога, но с договором, предложить можно');

-- ---- 20д. Подбор ищет по условиям клиента ----------------------------------
-- Этого не было вовсе: представления показывали уже сделанные подборы, а
-- подобрать было нечем — агент смотрел каталог глазами.
--
-- ДАННЫЕ ЗАВОДЯТСЯ НАРОЧНО «ПОЧТИ ПОДХОДЯЩИЕ». Первая версия этой проверки
-- была зелёной и бесполезной: в приёмочном наборе не было объектов, которые
-- ошибочный подбор захватил бы, и мутации, снимавшие фильтр по типу сделки,
-- бюджету, району и комнатам, выживали все четыре. Фильтр проверяется только
-- тем, что он отсекает.
--
-- req1: продажа, 70 000 – 120 000, районы Центр и Юг, 2–3 комнаты.
set role postgres;
delete from matches;
update objects set publication_state = 'published' where id = :'obj2';
update mandates set status = 'active';

do $$
declare
  v_agent uuid := '00000000-0000-0000-0000-0000000000a2';
  r record;
  v_id uuid;
begin
  for r in
    select * from (values
      -- Каждый ряд нарушает ровно одно условие потребности.
      ('f101', 'rent'::deal_type, 'Аренда в центре, 2 комнаты', 'Центр', 2::smallint, 90000::numeric),
      ('f102', 'sale'::deal_type, 'Дешевле нижней границы',     'Центр', 2::smallint, 30000::numeric),
      ('f103', 'sale'::deal_type, 'Не тот район',               'Север', 2::smallint, 90000::numeric),
      ('f104', 'sale'::deal_type, 'Не то число комнат',         'Центр', 5::smallint, 90000::numeric),
      -- А этот подходит по всем условиям: без него проверки «отсекает»
      -- ничего не стоят, ведь пустой подбор отсекает всё.
      ('f105', 'sale'::deal_type, 'Подходит по всем условиям',  'Юг',    3::smallint, 95000::numeric)
    ) as v(tag, deal, address, zone, rooms, price)
  loop
    insert into objects (kind, deal_type, address, zone, rooms, price, created_by_agent_id)
    values ('flat', r.deal, r.address, r.zone, r.rooms, r.price, v_agent)
    returning id into v_id;

    insert into mandates (object_id, kind, start_price, listing_agent_id,
                          contract_confirmed, status)
    values (v_id, 'non_exclusive', r.price, v_agent, true, 'active');
  end loop;
end $$;

set role authenticated;
set request.jwt.claims = :'claims_bakyt';

-- req1: продажа, 70 000 – 120 000, районы Центр и Юг, 2–3 комнаты.
select test.ok(
  (select count(*) from app.matching_objects(:'req1')) > 0,
  'подбор что-то находит');

select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where address = 'Подходит по всем условиям'),
  1, 'подходящий по всем условиям в подборе есть');

select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where address = 'Аренда в центре, 2 комнаты'),
  0, 'аренда под покупку не подбирается');

select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where address = 'Дешевле нижней границы'),
  0, 'дешевле нижней границы бюджета не подбирается');

select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where address = 'Не тот район'),
  0, 'объект в чужом районе не подбирается');

select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where address = 'Не то число комнат'),
  0, 'объект с чужим числом комнат не подбирается');

-- ---- 20е. Без договора в подбор не попадает --------------------------------
-- Подбор знает про договор заранее, а не узнаёт отказом при попытке.
set role postgres;
select object_id as first_hit from app.matching_objects(:'req1') limit 1 \gset
update mandates set status = 'expired' where object_id = :'first_hit';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where object_id = :'first_hit'),
  0, 'объект, потерявший договор, из подбора исчезает');

-- ---- 20ж. «Чуть дороже» показывается, а не прячется ------------------------
-- Объект на десятую часть выше потолка агент показывает сознательно, и
-- решать за него, прятать или нет, — не дело базы.
set role postgres;
update mandates set status = 'active';
insert into objects (id, kind, deal_type, address, zone, rooms, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000f001', 'flat', 'sale',
        'Чуть дороже потолка', 'Центр', 3, 126000, :'agent_bakyt');
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-00000000f001', 'non_exclusive', 126000,
        :'agent_bakyt', true, 'active');
insert into objects (id, kind, deal_type, address, zone, rooms, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000f002', 'flat', 'sale',
        'Сильно дороже потолка', 'Центр', 3, 200000, :'agent_bakyt');
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-00000000f002', 'non_exclusive', 200000,
        :'agent_bakyt', true, 'active');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select fit from app.matching_objects(:'req1')
    where object_id = '00000000-0000-0000-0000-00000000f001'),
  'чуть дороже', 'объект выше потолка на 5% приходит с пометкой');
select test.eq(
  (select count(*)::int from app.matching_objects(:'req1')
    where object_id = '00000000-0000-0000-0000-00000000f002'),
  0, 'объект вдвое выше потолка в подбор не попадает');

-- Точные совпадения идут раньше «чуть дороже»: иначе пометка бесполезна.
select test.ok(
  (select bool_and(fit = 'подходит') from (
     select fit from app.matching_objects(:'req1') limit 1) q),
  'первым идёт то, что в бюджет');

-- ---- 20з. Уже предложенное помечено ---------------------------------------
-- Иначе агент предлагает клиенту одно и то же дважды.
select id as mm from create_match('00000000-0000-0000-0000-00000000f001', :'req1') \gset
select test.ok(
  (select already_proposed from app.matching_objects(:'req1')
    where object_id = '00000000-0000-0000-0000-00000000f001'),
  'уже предложенный объект помечен');

-- ---- 20и. Потребность заводится вместе с клиентом --------------------------
select id as req_new from create_requirement(
  'rent', p_client_name => 'Айгуль Клиентова', p_client_phone => '0700 42 42 42',
  p_budget_max => 500, p_zones => array['Центр'], p_rooms => array[1,2]::smallint[]) \gset

select test.eq(
  (select count(*)::int from requirements where id = :'req_new'),
  1, 'потребность создана');
select test.eq(
  (select cp.phone from requirements r
     join contact_phones cp on cp.contact_id = r.contact_id
    where r.id = :'req_new'),
  '+996700424242', 'клиент заведён тем же действием, телефон нормализован');
select test.eq(
  (select agent_id from requirements where id = :'req_new'),
  :'agent_bakyt'::uuid, 'потребность ведёт тот, кто её завёл');

select test.throws(
  $$select create_requirement('sale')$$,
  'INVARIANT_20: у потребности должен быть клиент',
  'потребность без клиента не создать');

-- Тот же номер — тот же человек: клиент, который ищет вторую квартиру, не
-- должен превращаться во второго клиента.
select id as req_again from create_requirement(
  'sale', p_client_name => 'Айгуль К.', p_client_phone => '+996 700 424242',
  p_budget_max => 90000) \gset

select test.eq(
  (select count(distinct contact_id)::int from requirements
    where id in (:'req_new', :'req_again')),
  1, 'вторая потребность того же клиента привязана к тому же контакту');

-- ---- 20к. Каталогу подбор недоступен ---------------------------------------
set role postgres; set role anon;
select test.throws(
  format($$select * from app.matching_objects(%L)$$, :'req1'),
  'permission denied for function matching_objects',
  'аноним не подбирает');
select test.throws(
  $$select create_requirement('sale', p_client_name => 'Никто', p_client_phone => '0700000000')$$,
  'permission denied for function create_requirement',
  'аноним не заводит потребностей');
