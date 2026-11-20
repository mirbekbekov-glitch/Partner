-- Собственность объекта (миграция 0023).
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_aibek';
set role authenticated;

insert into contacts (id, name, roles) values
  ('00000000-0000-0000-0000-00000000f101', 'Совладелец А', '{owner}'),
  ('00000000-0000-0000-0000-00000000f102', 'Совладелец Б', '{owner}');

-- ===========================================================================
-- Доли не превышают целого
-- ===========================================================================
-- Было: сумма долей по объекту доходила до 2.6.

-- У obj2 из сценария уже есть собственник с долей 1.
select test.eq((select sum(share) from object_ownerships where object_id = :'obj2'),
  1.0000::numeric, 'у объекта уже занято сто процентов');

select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f101',
                                       'co_owner', 0.5)$$, :'obj2'),
  'сумма долей',
  'доля сверх целого отклонена');

-- Освободим место и добавим двух совладельцев по половине.
select set_object_ownership(:'obj2', :'contact_owner', 'owner'::ownership_role, 0.5);
select set_object_ownership(:'obj2', '00000000-0000-0000-0000-00000000f101',
                            'co_owner'::ownership_role, 0.5);
select test.eq((select sum(share) from object_ownerships where object_id = :'obj2'),
  1.0000::numeric, 'две половины складываются ровно в целое');

select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f102',
                                       'co_owner', 0.01)$$, :'obj2'),
  'сумма долей',
  'и сотая доля сверху уже не проходит');

-- Доля без значения допустима: она просто неизвестна.
select set_object_ownership(:'obj2', '00000000-0000-0000-0000-00000000f102',
                            'contact_person'::ownership_role, null);
select test.ok(
  (select share is null from object_ownerships
    where object_id = :'obj2' and contact_id = '00000000-0000-0000-0000-00000000f102'),
  'связь без доли заводится: доля может быть неизвестна');

-- Свободный объект для проверок ниже: у obj1..obj3 из сценария сто
-- процентов уже заняты собственником.
select * from create_object(
  p_kind => 'flat', p_deal_type => 'sale', p_address => 'Свободный от долей', p_price => 60000
) \gset free_

-- Диапазон доли.
select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f101',
                                       'co_owner', 1.5)$$, :'free_id'),
  'от 0 до 1',
  'доля больше единицы отклонена понятным сообщением');
select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f101',
                                       'co_owner', 0)$$, :'free_id'),
  'от 0 до 1',
  'нулевая доля отклонена');

-- ===========================================================================
-- Смена роли — перенос, а не вторая связь
-- ===========================================================================
-- Роль входит в ключ (object_id, contact_id, role), поэтому наивный UPDATE
-- оставил бы у человека две роли по одному объекту.

select set_object_ownership(:'free_id', '00000000-0000-0000-0000-00000000f101',
                            'co_owner'::ownership_role, 0.3);
select set_object_ownership(:'free_id', '00000000-0000-0000-0000-00000000f101',
                            'proxy'::ownership_role, null);
select test.eq(
  (select count(*)::int from object_ownerships
    where object_id = :'free_id' and contact_id = '00000000-0000-0000-0000-00000000f101'), 1,
  'у человека по объекту одна роль, а не набор');
select test.eq(
  (select role from object_ownerships
    where object_id = :'free_id' and contact_id = '00000000-0000-0000-0000-00000000f101'),
  'proxy'::ownership_role, 'роль заменилась, а не добавилась');

-- Повторный вызов с той же ролью меняет только долю.
select set_object_ownership(:'free_id', '00000000-0000-0000-0000-00000000f101',
                            'proxy'::ownership_role, 0.25);
select test.eq(
  (select share from object_ownerships
    where object_id = :'free_id' and contact_id = '00000000-0000-0000-0000-00000000f101'),
  0.2500::numeric, 'повторный вызов обновляет долю');

-- ===========================================================================
-- Структурные поля связи закрыты
-- ===========================================================================

select test.throws(
  format($$update object_ownerships set object_id = %L
            where object_id = %L and contact_id = %L$$,
         :'free_id', :'obj1', :'contact_owner'),
  'permission denied',
  'переподвязать связь к другому объекту нельзя');
select test.throws(
  format($$update object_ownerships set contact_id = '00000000-0000-0000-0000-00000000f101'
            where object_id = %L and contact_id = %L$$, :'obj1', :'contact_owner'),
  'permission denied',
  'подменить контакт в связи нельзя');

-- Роль и долю править можно: это содержательные поля.
update object_ownerships set share = 0.9
 where object_id = :'obj1' and contact_id = :'contact_owner';
select test.ok(true, 'долю агент правит прямым UPDATE');
reset role;

-- ===========================================================================
-- Пока идёт сделка, объект не остаётся без собственника
-- ===========================================================================
-- Было: снятие связи отбирало у closing-агента телефон собственника, а
-- сделка продолжалась. Связь и есть основание доступа.

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
select * from create_deal_from_match(:'m_id') \gset d_
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$,
                            :'contact_owner')),
  1::bigint, 'участник сделки видит телефон собственника');
reset role;

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  format($$select remove_object_ownership(%L, %L)$$, :'obj1', :'contact_owner'),
  'не может остаться без собственника',
  'последнего собственника при открытой сделке снять нельзя');
-- И прямым запросом тоже: держит триггер, а не функция.
select test.throws(
  format($$delete from object_ownerships where object_id = %L and contact_id = %L$$,
         :'obj1', :'contact_owner'),
  'не может остаться без собственника',
  'и прямым DELETE тоже');
reset role;

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq(
  test.visible_count(format($$select 1 from contact_phones where contact_id = %L$$,
                            :'contact_owner')),
  1::bigint, 'доступ участника сделки к телефону не пропал');
reset role;

-- ---- Но исправить ошибочного собственника можно -------------------------
-- Сначала добавить верного, потом снять неверного: без собственника объект
-- ни на миг не остаётся.
set request.jwt.claims = :'claims_aibek';
set role authenticated;
select set_object_ownership(:'obj1', '00000000-0000-0000-0000-00000000f101',
                            'owner'::ownership_role, null);
select test.ok(
  remove_object_ownership(:'obj1', :'contact_owner') is not null,
  'после добавления верного собственника неверного снять можно');
select test.eq(
  (select count(*)::int from object_ownerships
    where object_id = :'obj1' and role in ('owner','co_owner')), 1,
  'собственник у объекта остался');
reset role;

-- ===========================================================================
-- Без сделки объект можно оставить и без собственника
-- ===========================================================================
-- Объект без собственника — это записанный лид, и create_object() его
-- допускает. Запрещать такое состояние вообще значило бы запрещать лиды.

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(
  remove_object_ownership(:'free_id', '00000000-0000-0000-0000-00000000f101') is not null,
  'связь по объекту без сделки снимается свободно');

-- ===========================================================================
-- Чужое не связать
-- ===========================================================================

-- contact_client для этого НЕ годится: по его потребности идёт сделка, где
-- Айбек listing-агент, и инвариант 4 контакт ему как раз открывает.
-- Нужен контакт без всякой связи с ним.
reset role;
insert into contacts (id, name, owner_agent_id, roles)
values ('00000000-0000-0000-0000-00000000f104', 'Совсем чужой', :'agent_bakyt', '{owner}');

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f104',
                                       'owner', null)$$, :'free_id'),
  'контакт вам не доступен',
  'чужой контакт к своему объекту не привязать');
reset role;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
insert into contacts (id, name, roles)
values ('00000000-0000-0000-0000-00000000f103', 'Свой контакт Чынгыза', '{owner}');
select test.throws(
  format($$select set_object_ownership(%L, '00000000-0000-0000-0000-00000000f103',
                                       'owner', null)$$, :'obj2'),
  'кто за объект отвечает',
  'свой контакт к чужому объекту не привязать');
select test.throws(
  format($$select remove_object_ownership(%L, %L)$$, :'obj2', :'contact_owner'),
  'кто отвечает за объект',
  'связь чужого объекта не снять');
reset role;

-- ===========================================================================
-- Список объектов для связи
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok(test.visible_count($$select 1 from linkable_objects_v$$) >= 1,
  'свои объекты для связи предлагаются');
reset role;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(test.visible_count($$select 1 from linkable_objects_v$$), 0::bigint,
  'агенту без своих объектов предлагать нечего');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from linkable_objects_v$$, 'permission denied',
  'список объектов для связи анониму недоступен');
reset role;
