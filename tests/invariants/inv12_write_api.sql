-- Создание и правка объектов и потребностей (миграция 0015).
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Создание объекта: объект, собственник и мандат одной транзакцией
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;

select * from create_object(
  p_kind => 'flat', p_deal_type => 'sale',
  p_address => 'Токтогула 140, кв. 9', p_price => 92000,
  p_zone => 'Центр', p_rooms => 2::smallint, p_area => 61.5, p_floor => 4::smallint,
  p_photos => E'https://example.kg/1.jpg\nhttps://example.kg/2.jpg',
  p_owner_name => 'Сыдыков Собственник', p_owner_phone => '+996700555444',
  p_mandate_kind => 'exclusive', p_contract_confirmed => true
) \gset o_

select test.eq(:'o_publication_state'::text, 'draft',
  'новый объект создан ЧЕРНОВИКОМ: публикация отдельный шаг');
select test.eq(:'o_created_by_agent_id'::text, :'agent_aibek'::text,
  'объект записан на создавшего агента');
select test.eq((select jsonb_array_length(photos) from objects where id = :'o_id'), 2,
  'обе ссылки на фото разобраны');

-- Собственник заведён и достался тому, кто его привёл: инвариант 4.
select test.eq(
  (select c.name from object_ownerships oo join contacts c on c.id = oo.contact_id
    where oo.object_id = :'o_id'),
  'Сыдыков Собственник', 'собственник заведён и связан с объектом');
select test.eq(
  (select c.owner_agent_id from object_ownerships oo join contacts c on c.id = oo.contact_id
    where oo.object_id = :'o_id')::text,
  :'agent_aibek'::text, 'новый контакт достался агенту, который его привёл');
select test.eq(
  (select cp.phone from object_ownerships oo
     join contact_phones cp on cp.contact_id = oo.contact_id
    where oo.object_id = :'o_id'),
  '+996700555444', 'телефон собственника записан');

-- Мандат создан активным, значит объект можно публиковать.
select test.eq(
  (select kind from mandates where object_id = :'o_id' and status = 'active'),
  'exclusive'::mandate_kind, 'мандат создан активным');
select test.eq((publish_object(:'o_id')).publication_state, 'published'::publication_state,
  'объект с мандатом публикуется сразу после создания');

-- ===========================================================================
-- Без мандата объект публиковать нельзя (инвариант 1 не обойдён формой)
-- ===========================================================================

select * from create_object(
  p_kind => 'flat', p_deal_type => 'rent',
  p_address => 'Без договора 1', p_price => 400
) \gset nm_

select test.ok((select app.active_mandate_id(:'nm_id') is null),
  'без p_mandate_kind мандат не создаётся');
select test.throws(
  format($$select publish_object(%L)$$, :'nm_id'),
  'INVARIANT_1',
  'созданный через форму объект без мандата публиковать нельзя');

-- Мандат можно добавить потом — иначе объект остался бы непубликуемым.
select * from create_mandate(:'nm_id', 'non_exclusive'::mandate_kind) \gset cm_
select test.eq(:'cm_start_price'::numeric, 400::numeric,
  'стартовая цена мандата по умолчанию равна цене объекта');
select test.eq((publish_object(:'nm_id')).publication_state, 'published'::publication_state,
  'после добавления мандата объект публикуется');

-- Второй активный мандат отклонён понятным сообщением, а не ошибкой индекса.
select test.throws(
  format($$select create_mandate(%L, 'exclusive')$$, :'nm_id'),
  'у объекта уже есть активный мандат',
  'второй активный мандат отклонён понятным сообщением');

-- ===========================================================================
-- Атомарность
-- ===========================================================================
-- Если мандат не прошёл проверку, не должно остаться ни объекта, ни контакта.
-- Иначе каждая неудачная попытка оставляла бы мусор и осиротевшие контакты.

select count(*) as obj_before from objects \gset
select count(*) as con_before from contacts \gset

select test.throws(
  $$select create_object(
      p_kind => 'flat', p_deal_type => 'sale',
      p_address => 'Атомарность', p_price => 50000,
      p_owner_name => 'Не должен появиться',
      p_mandate_kind => 'exclusive',
      p_mandate_valid_to => current_date - 1)$$,
  'INVARIANT_1',
  'мандат с истёкшим сроком отклонён');

select test.eq((select count(*) from objects)::int, :'obj_before'::int,
  'после неудачи объект не остался');
select test.eq((select count(*) from contacts)::int, :'con_before'::int,
  'после неудачи контакт собственника не остался');
select test.eq(
  (select count(*)::int from contacts where name = 'Не должен появиться'), 0,
  'осиротевшего контакта нет');

-- ===========================================================================
-- Правка объекта: инвариант 5 через новый путь
-- ===========================================================================

select actual_at as a0, published_at as p0 from objects where id = :'o_id' \gset
select pg_sleep(0.05);

select * from update_object(
  p_id => :'o_id', p_kind => 'flat', p_deal_type => 'sale',
  p_address => 'Токтогула 140, кв. 9', p_price => 95000,
  p_zone => 'Центр', p_rooms => 2::smallint, p_area => 61.5, p_floor => 4::smallint
) \gset u_

select test.eq(:'u_price'::numeric, 95000::numeric, 'цена изменена');
select test.ok((select actual_at > :'a0'::timestamptz from objects where id = :'o_id'),
  'правка цены через форму подняла actual_at');
select test.eq((select published_at from objects where id = :'o_id'), :'p0'::timestamptz,
  'published_at правкой не затронут');

-- Фото тоже поднимают актуальность.
select actual_at as a1 from objects where id = :'o_id' \gset
select pg_sleep(0.05);
select update_object(
  p_id => :'o_id', p_kind => 'flat', p_deal_type => 'sale',
  p_address => 'Токтогула 140, кв. 9', p_price => 95000,
  p_photos => 'https://example.kg/new.jpg');
select test.ok((select actual_at > :'a1'::timestamptz from objects where id = :'o_id'),
  'правка фото через форму подняла actual_at');
select test.eq((select jsonb_array_length(photos) from objects where id = :'o_id'), 1,
  'набор фото заменён целиком, как показывает форма');
reset role;

-- ===========================================================================
-- Кто может править объект
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  format($$select update_object(p_id => %L, p_kind => 'flat', p_deal_type => 'sale',
                                p_address => 'Взлом', p_price => 1)$$, :'o_id'),
  'FORBIDDEN',
  'посторонний агент чужой объект не правит');
-- Но видит его: «объект, условия и комиссия да».
select test.eq(test.visible_count(format($$select 1 from objects where id = %L$$, :'o_id')),
  1::bigint, 'при этом объект ему виден');

-- А это главная проверка: PostgREST отдаёт таблицы напрямую, поэтому агент
-- может послать PATCH /objects, минуя update_object. Держать его обязана
-- политика, а не функция. RLS молча не находит строку, поэтому смотрим
-- результат, а не отказ.
update objects set price = 1 where id = :'o_id';
reset role;
select test.eq((select price from objects where id = :'o_id'), 95000.00::numeric,
  'прямой UPDATE в обход функции отбит политикой: цена не изменилась');

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
update objects set photos = '[]'::jsonb where id = :'o_id';
reset role;
select test.eq((select jsonb_array_length(photos) from objects where id = :'o_id'), 1,
  'и фото прямым UPDATE не стёрлись');

-- listing-агент активного мандата правит, даже если объект завёл не он.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_object(
  p_kind => 'flat', p_deal_type => 'sale', p_address => 'Чужой заводил', p_price => 70000
) \gset bo_
reset role;

-- Мандат на этот объект берёт Айбек.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select create_mandate(:'bo_id', 'non_exclusive'::mandate_kind);
select test.eq(
  (update_object(p_id => :'bo_id', p_kind => 'flat', p_deal_type => 'sale',
                 p_address => 'Правка listing-агентом', p_price => 71000)).address,
  'Правка listing-агентом',
  'listing-агент активного мандата правит объект, который завёл не он');
reset role;

-- ===========================================================================
-- Расторжение мандата снимает объект с публикации
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select id as mid from mandates where object_id = :'o_id' and status = 'active' \gset
select * from terminate_mandate(:'mid', 'собственник передумал'::text) \gset tm_
select test.eq(:'tm_status'::text, 'terminated', 'мандат расторгнут');
select test.eq((select publication_state from objects where id = :'o_id'),
  'withdrawn'::publication_state,
  'расторжение через форму сняло объект с публикации');
reset role;

-- Чужой мандат расторгнуть нельзя.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  format($$select terminate_mandate(%L)$$, :'cm_id'),
  'FORBIDDEN',
  'чужой мандат расторгнуть нельзя');
reset role;

-- ===========================================================================
-- Создание потребности
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select * from create_requirement(
  p_deal_type => 'sale',
  p_client_name => 'Абдыраманов Клиент', p_client_phone => '+996700777666',
  p_budget_min => 60000, p_budget_max => 95000,
  p_zones => 'Центр, Юг, Центр', p_rooms => '2, 3, abc',
  p_requirements_text => 'Не первый и не последний этаж'
) \gset r_

select test.eq(:'r_status'::text, 'new', 'новая потребность создана со статусом «новая»');
select test.eq(:'r_agent_id'::text, :'agent_bakyt'::text, 'потребность записана на агента');
select test.eq((select zones from requirements where id = :'r_id'),
  '{Центр,Юг}'::text[], 'зоны разобраны, дубликат убран');
select test.eq((select rooms from requirements where id = :'r_id'),
  '{2,3}'::smallint[], 'комнаты разобраны, мусор отброшен');
select test.eq(
  (select c.owner_agent_id from contacts c where c.id = :'r_contact_id')::text,
  :'agent_bakyt'::text, 'новый клиент достался агенту, который его привёл');

-- Потребность без клиента невозможна: иначе она ничья.
select test.throws(
  $$select create_requirement(p_deal_type => 'sale', p_budget_max => 100000)$$,
  'потребность без клиента невозможна',
  'потребность без клиента отклонена');

-- У одного клиента может быть несколько потребностей одновременно.
select create_requirement(
  p_deal_type => 'rent', p_contact_id => :'r_contact_id', p_budget_max => 600);
select test.eq((select count(*)::int from requirements where contact_id = :'r_contact_id'), 2,
  'у одного клиента две одновременные потребности');

-- ===========================================================================
-- Правка потребности
-- ===========================================================================

select * from update_requirement(
  p_id => :'r_id', p_deal_type => 'sale',
  p_budget_min => 70000, p_budget_max => 100000,
  p_zones => 'Запад', p_rooms => '3',
  p_status => 'qualified'::requirement_status
) \gset ur_
select test.eq(:'ur_status'::text, 'qualified', 'статус потребности изменён');
select test.eq((select zones from requirements where id = :'r_id'), '{Запад}'::text[],
  'зоны заменены целиком, как показывает форма');

-- «В сделке» руками не ставится: это следствие создания сделки (инвариант 2).
select test.throws(
  format($$select update_requirement(p_id => %L, p_deal_type => 'sale',
                                     p_status => 'in_deal')$$, :'r_id'),
  'INVARIANT_2',
  'статус «в сделке» вручную не ставится');

-- Закрыть руками можно: клиент мог купить сам или отказаться.
select test.eq(
  (update_requirement(p_id => :'r_id', p_deal_type => 'sale',
                      p_status => 'lost'::requirement_status,
                      p_closed_reason => 'купил сам'::text)).status,
  'lost'::requirement_status, 'отвал ставится вручную с причиной');
reset role;

-- Чужую потребность править нельзя.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  format($$select update_requirement(p_id => %L, p_deal_type => 'sale')$$, :'r_id'),
  'FORBIDDEN',
  'чужую потребность править нельзя');
reset role;

-- ===========================================================================
-- Журнал: инвариант 7 через новые пути
-- ===========================================================================
select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'object' and entity_id = :'o_id' and action = 'insert'),
  'создание объекта через форму попало в журнал');
select test.ok(
  (select actor_agent_id = :'agent_aibek'::uuid from audit_log
    where entity_type = 'object' and entity_id = :'o_id' and action = 'insert'),
  'в журнале записан агент, создавший объект');
select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'requirement' and entity_id = :'r_id' and action = 'insert'),
  'создание потребности попало в журнал');
