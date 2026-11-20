-- ИНВАРИАНТ 22. Объект ведёт listing-агент действующего договора: он один
--               правит данные, публикует, снимает и подтверждает
--               актуальность. Потребность правит её агент, контакт — тот,
--               кто его ведёт.
--
-- Найдено запросом от имени постороннего агента:
--
--     update objects set price = 1 where id = <чужой объект>;
--
-- Цена чужого объекта поменялась с 85 000 на 1. Политика objects_update
-- проверяла только «одобренный агент». Мандат и потребность при той же
-- проверке устояли — у них политики написаны по владельцу.
--
-- Почему listing-агент, а не создатель записи: отвечает перед собственником
-- тот, с кем у собственника договор. Фотографии (инвариант 11) устроены так
-- же — одно понятие «свой объект» на весь кабинет.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 22а. Чужой объект не править -----------------------------------------
set role authenticated;
set request.jwt.claims = :'claims_chyngyz';

select test.throws(
  format($$update objects set price = 1 where id = %L$$, :'obj1'),
  'INVARIANT_22: объект ведёт агент действующего договора',
  'цену чужого объекта не переписать');

select test.throws(
  format($$select update_object(%L, 1, 'Чужой адрес')$$, :'obj1'),
  'INVARIANT_22: объект ведёт агент действующего договора',
  'и функцией правки тоже');

select test.throws(
  format($$select publish_object(%L)$$, :'obj1'),
  'INVARIANT_22: публикует объект агент действующего договора',
  'чужой объект не опубликовать');

select test.throws(
  format($$select withdraw_object(%L)$$, :'obj1'),
  'INVARIANT_22: снимает объект агент действующего договора',
  'чужой объект не снять с каталога');

-- Подтверждение актуальности — тоже заявление собственнику и покупателям,
-- что цена и фотографии в силе. За чужой объект такого не заявляют.
select test.throws(
  format($$select app.confirm_actual(%L)$$, :'obj1'),
  'INVARIANT_22: актуальность подтверждает агент действующего договора',
  'за чужой объект актуальность не подтвердить');

select test.eq(
  (select price from objects where id = :'obj1'), 85000::numeric,
  'после всех попыток цена прежняя');

-- ---- 22а-бис. Ведёт объект владелец договора, а не создатель записи -------
-- В приёмочных данных это один и тот же человек, и подмена одного правила
-- другим проходила незамеченной: мутация «ведущим считается создатель»
-- выживала. В жизни они расходятся часто — объект завели из объявления, а
-- договор заключил другой агент.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000fa33', 'flat', 'sale',
        'Завёл один, договор у другого', 80000, :'agent_chyngyz');
insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values ('00000000-0000-0000-0000-00000000fa33', 'non_exclusive', 80000,
        :'agent_aibek', true, 'active');

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  $$select update_object('00000000-0000-0000-0000-00000000fa33', 81000,
      'Завёл один, договор у другого')$$,
  'INVARIANT_22: объект ведёт агент действующего договора',
  'завёдший объект его не правит, если договор у другого');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select price from update_object('00000000-0000-0000-0000-00000000fa33', 81000,
     'Завёл один, договор у другого')),
  81000::numeric, 'правит владелец договора, хотя заводил не он');

-- ---- 22б. Свой объект правится --------------------------------------------
-- Инвариант про запреты легко «выполнить», запретив всё.
set request.jwt.claims = :'claims_aibek';

select price as before_price, actual_at as before_actual
  from objects where id = :'obj1' \gset

select test.eq(
  (select price from update_object(:'obj1', 91000, 'Чүй 120, кв. 5',
      p_zone => 'Центр', p_rooms => 2::smallint, p_area => 58,
      p_description => 'Окна во двор')),
  91000::numeric, 'ведущий агент правит цену');

select test.eq(
  (select description from objects where id = :'obj1'),
  'Окна во двор', 'и описание');

-- Инвариант 5: правка цены поднимает актуальность, и делает это триггер, а
-- не функция правки.
select test.ok(
  (select actual_at from objects where id = :'obj1') > :'before_actual'::timestamptz,
  'правка цены подняла дату подтверждения');

-- ---- 22в. Правка цены попадает в журнал ------------------------------------
-- Цена — то, из-за чего спорят с собственником. Кто и когда её менял, должно
-- быть видно (инвариант 7).
set role postgres;
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'object' and entity_id = :'obj1'
      and action = 'update' and diff ? 'price') >= 1,
  'изменение цены записано в журнал');

-- ---- 22г. Объект без договора правит тот, кто его завёл --------------------
-- Иначе объект с истёкшим мандатом становится неисправимым, и даже заключить
-- по нему новый договор нельзя.
set request.jwt.claims = '{}';
update mandates set status = 'expired' where object_id = :'obj1';

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select update_object(%L, 70000, 'Чүй 120, кв. 5')$$, :'obj1'),
  'INVARIANT_22: объект ведёт агент действующего договора',
  'объект без договора посторонний всё равно не правит');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select price from update_object(:'obj1', 70000, 'Чүй 120, кв. 5')),
  70000::numeric, 'завёдший объект правит его и без действующего договора');

-- ---- 22д. Снятие вслед за закрытым договором разрешено всем ----------------
-- Это не правка, а требование инварианта 1: выполняет его тот, кто закрыл
-- сделку, а он чаще всего агент покупателя, а не владелец мандата.
-- Объект заводится без договора: ровно в таком состоянии он оказывается
-- после закрытия сделки, когда мандат стал closed_by_deal.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000fa22', 'flat', 'sale',
        'Договор закончился', 60000, :'agent_aibek');

set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
update objects set publication_state = 'withdrawn'
 where id = '00000000-0000-0000-0000-00000000fa22';
select test.eq(
  (select publication_state from objects
    where id = '00000000-0000-0000-0000-00000000fa22'),
  'withdrawn'::publication_state,
  'снятие объекта без договора проходит у любого агента: это требование инварианта 1');

-- А вот опубликовать такой объект посторонний не может — и первым откажет
-- не инвариант 1, а правило о том, чей это объект.
select test.throws(
  $$update objects set publication_state = 'published'
     where id = '00000000-0000-0000-0000-00000000fa22'$$,
  'INVARIANT_22: объект ведёт агент действующего договора',
  'а опубликовать чужой объект без договора — нет');

-- ---- 22е. Потребность правит её агент --------------------------------------
select test.throws(
  format($$select update_requirement(%L, p_budget_max => 1)$$, :'req1'),
  'INVARIANT_22: потребность правит её агент',
  'чужую потребность не править');

set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select budget_max from update_requirement(:'req1',
     p_budget_min => 60000, p_budget_max => 95000,
     p_zones => array['Центр'], p_rooms => array[2]::smallint[])),
  95000::numeric, 'свою потребность агент правит');
select test.eq(
  (select zones from requirements where id = :'req1'),
  array['Центр'], 'и районы тоже');

-- ---- 22ж. Контакт правит тот, кто его ведёт --------------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select update_contact(%L, 'Переименован')$$, :'contact_owner'),
  'FORBIDDEN: этот контакт вам не виден',
  'чужой контакт не переименовать');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select name from update_contact(:'contact_owner', 'Орозов Азамат',
     '0700 99 11 22')),
  'Орозов Азамат', 'свой контакт агент правит');

set role postgres;
select test.eq(
  (select phone from contact_phones
    where contact_id = :'contact_owner' and is_primary),
  '+996700991122', 'телефон заменён и нормализован, а не добавлен вторым');
select test.eq(
  (select count(*)::int from contact_phones
    where contact_id = :'contact_owner' and is_primary),
  1, 'основной телефон по-прежнему один');

-- ---- 22з. Договор правит его владелец --------------------------------------
set role authenticated;
set request.jwt.claims = :'claims_chyngyz';
select mandate_id as md from (
  select id as mandate_id from mandates where object_id = :'obj3' and status = 'active') q \gset

select test.throws(
  format($$select update_mandate(%L, 'exclusive')$$, :'md'),
  'INVARIANT_22: условия договора меняет его владелец',
  'чужой договор не править');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select kind from update_mandate(:'md', 'exclusive',
     p_valid_to => current_date + 90, p_contract_confirmed => true)),
  'exclusive'::mandate_kind, 'свой договор владелец правит');

-- ---- 22и. Каталогу правка недоступна ----------------------------------------
set role postgres; set role anon;
select test.throws(
  format($$select update_object(%L, 1, 'Адрес')$$, :'obj1'),
  'permission denied for function update_object',
  'аноним объекты не правит');
select test.throws(
  format($$select update_contact(%L, 'Имя')$$, :'contact_owner'),
  'permission denied for function update_contact',
  'аноним контакты не правит');
