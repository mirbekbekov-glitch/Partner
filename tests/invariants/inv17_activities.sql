-- Активности (миграция 0020).
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- ===========================================================================
-- done и done_at не расходятся
-- ===========================================================================
-- Было: done=true принимался без done_at, а done_at — в будущем при done=false.

insert into activities (kind, entity_type, entity_id, body, done)
values ('task', 'object', :'obj1', 'позвонить собственнику', true)
returning id as a1 \gset
select test.ok((select done_at is not null from activities where id = :'a1'),
  'done=true без даты: дата выставлена триггером');

-- Слой первый: done_at агенту вообще не выдан — его ведёт триггер.
select test.throws(
  format($$insert into activities (kind, entity_type, entity_id, body, done, done_at)
           values ('call', 'object', %L, 'звонок', false, now())$$, :'obj1'),
  'permission denied',
  'done_at агенту не выдан: датой выполнения распоряжается триггер');
reset role;

-- Слой второй: даже в обход грантов триггер приводит дату в порядок.
insert into activities (kind, entity_type, entity_id, agent_id, body, done, done_at)
values ('call', 'object', :'obj1', :'agent_aibek', 'звонок', false, now() + interval '100 days')
returning id as a2 \gset
select test.ok((select done_at is null from activities where id = :'a2'),
  'done=false: дата выполнения стёрта, а не оставлена в будущем');

insert into activities (kind, entity_type, entity_id, agent_id, body, done, done_at)
values ('task', 'object', :'obj1', :'agent_aibek', 'в будущем', true, now() + interval '100 days')
returning id as a3 \gset
select test.ok((select done_at <= now() from activities where id = :'a3'),
  'дата выполнения в будущем прижата к настоящему');

set request.jwt.claims = :'claims_aibek';
set role authenticated;

-- Снятие отметки стирает дату.
update activities set done = false where id = :'a1';
select test.ok((select done_at is null from activities where id = :'a1'),
  'снятие отметки стирает дату выполнения');

-- Повторная отметка не сдвигает уже зафиксированную дату.
update activities set done = true where id = :'a1';
select done_at as d1 from activities where id = :'a1' \gset
update activities set body = 'правка текста' where id = :'a1';
select test.eq((select done_at from activities where id = :'a1'), :'d1'::timestamptz,
  'правка текста выполненной задачи дату выполнения не двигает');

-- ===========================================================================
-- agent_id: по умолчанию свой, подарить нельзя
-- ===========================================================================

insert into activities (kind, entity_type, entity_id, body)
values ('note', 'object', :'obj1', 'без указания агента')
returning id as a4 \gset
select test.eq((select agent_id from activities where id = :'a4')::text,
  :'agent_aibek'::text, 'agent_id подставляется свой по умолчанию');

select test.throws(
  format($$update activities set agent_id = %L where id = %L$$, :'agent_bakyt', :'a4'),
  'permission denied',
  'подарить активность другому агенту нельзя: колонка не выдана');
reset role;

-- Присвоить чужую тоже нельзя (политика, проверено и в разборе).
insert into activities (id, kind, entity_type, entity_id, agent_id, body)
values ('00000000-0000-0000-0000-00000000aa01', 'note', 'object', :'obj2',
        :'agent_bakyt', 'чужая заметка');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
update activities set body = 'присвоил'
 where id = '00000000-0000-0000-0000-00000000aa01';
reset role;
select test.eq((select body from activities
                 where id = '00000000-0000-0000-0000-00000000aa01'),
  'чужая заметка', 'чужую активность не переписать: политика строку не находит');

-- ===========================================================================
-- Приватность по умолчанию
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from activities
                               where entity_type='object' and entity_id = %L$$, :'obj1')),
  0::bigint, 'по умолчанию активности по объекту коллеге не видны');
reset role;

-- ===========================================================================
-- Поделиться: видят те, кто работает по сущности
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
insert into activities (kind, entity_type, entity_id, body, is_shared)
values ('showing', 'object', :'obj1', 'показ прошёл, собственник просил не звонить до 10', true)
returning id as sh \gset
reset role;

-- Бакыт к obj1 отношения не имеет: ни завёл, ни listing-агент.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from activities where id = %L$$, :'sh')),
  0::bigint, 'общая активность не видна тому, кто по сущности не работает');
reset role;

-- А listing-агент активного мандата по этому объекту — это сам Айбек.
-- Передадим объект Бакыту: теперь он отвечает за объект и должен увидеть.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select transfer_object(:'obj1', :'agent_bakyt');
reset role;

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from activities where id = %L$$, :'sh')),
  1::bigint, 'после передачи объекта новый ответственный видит общую активность');
select test.eq((select body from activities where id = :'sh'),
  'показ прошёл, собственник просил не звонить до 10',
  'и читает её текст: согласовать показ стало чем');

-- Но приватные активности коллеги по тому же объекту по-прежнему закрыты.
select test.eq(
  test.visible_count(format($$select 1 from activities
                               where entity_type='object' and entity_id = %L
                                 and not is_shared$$, :'obj1')),
  0::bigint, 'приватные активности остаются закрытыми и для ответственного');

-- Чужую общую активность он видит, но не правит.
update activities set body = 'переписал' where id = :'sh';
reset role;
select test.eq((select body from activities where id = :'sh'),
  'показ прошёл, собственник просил не звонить до 10',
  'общую активность коллеги можно читать, но не править');

-- ===========================================================================
-- Сделка: обе стороны видят общие активности друг друга
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj2', :'req1') \gset m_
select * from create_deal_from_match(:'m_id') \gset d_
insert into activities (kind, entity_type, entity_id, body, is_shared)
values ('note', 'deal', :'d_id', 'аванс внесён наличными', true);
reset role;

-- Айбек — listing-агент этой сделки (мандат на obj2 его).
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from activities
                               where entity_type='deal' and entity_id = %L$$, :'d_id')),
  1::bigint, 'вторая сторона сделки видит общую активность по ней');
reset role;

-- А посторонний — нет, хотя саму сделку в списке видит.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from activities
                               where entity_type='deal' and entity_id = %L$$, :'d_id')),
  0::bigint, 'посторонний активности по сделке не видит');
select test.eq(
  test.visible_count(format($$select 1 from deal_list_v where id = %L$$, :'d_id')),
  1::bigint, 'хотя саму сделку в списке видит: комиссия агентам открыта');
reset role;

-- ===========================================================================
-- Лента: заголовок сущности и просрочка
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
insert into activities (kind, entity_type, entity_id, body, due_at)
values ('task', 'object', :'obj1', 'просроченная задача', now() - interval '2 days')
returning id as od \gset

select test.ok((select overdue from activity_feed_v where id = :'od'),
  'просроченная задача помечена в ленте');
select test.eq((select entity_title from activity_feed_v where id = :'od'),
  'Чүй 120, кв. 5', 'лента показывает, к чему привязана активность');
select test.ok((select mine from activity_feed_v where id = :'od'),
  'своя активность помечена как своя');

-- Выполненная задача не просрочена, даже если срок прошёл.
update activities set done = true where id = :'od';
select test.ok((select not overdue from activity_feed_v where id = :'od'),
  'выполненная задача просроченной не считается');

-- Привязка к невидимой сущности не выбрасывает строку из ленты.
--
-- contact_owner для этого НЕ годится: Бакыт его видит — он closing-агент
-- открытой сделки по объекту этого собственника, а инвариант 4 участникам
-- активной сделки контакт как раз открывает. Нужен контакт без связи с ним.
reset role;
insert into contacts (id, name, owner_agent_id)
values ('00000000-0000-0000-0000-00000000cd01', 'Ничей для Бакыта', :'agent_aibek');
set request.jwt.claims = :'claims_bakyt';
set role authenticated;

insert into activities (kind, entity_type, entity_id, body)
values ('note', 'contact', '00000000-0000-0000-0000-00000000cd01', 'о чужом контакте')
returning id as hid \gset
select test.eq(
  test.visible_count(format($$select 1 from activity_feed_v where id = %L$$, :'hid')),
  1::bigint, 'активность на невидимый контакт из ленты не исчезает');
select test.ok((select entity_title is null from activity_feed_v where id = :'hid'),
  'а заголовок такой сущности приходит пустым');
reset role;

-- ===========================================================================
-- Привязка к несуществующей сущности
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  $$insert into activities (kind, entity_type, entity_id, body)
    values ('note', 'object', gen_random_uuid(), 'в никуда')$$,
  'несуществующий',
  'активность на несуществующую сущность отклонена');
select test.throws(
  $$insert into activities (kind, entity_type, entity_id, body)
    values ('note', 'payment', gen_random_uuid(), 'неизвестный тип')$$,
  'неизвестный тип сущности',
  'неизвестный тип сущности отклонён внятным сообщением, а не внутренней ошибкой');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from activity_feed_v$$, 'permission denied',
  'лента активностей анониму недоступна');
reset role;
