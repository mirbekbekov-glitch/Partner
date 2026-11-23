-- ОТЧЁТ. Фильтр «требуют внимания» в поиске по объектам (миграция 0050).
--
-- Не инвариант: правил этот фильтр не устанавливает. Но на нём держится
-- путь от цифры к делу. На сводке есть плитка «N объектов требуют внимания
-- срочно», и раньше она вела на весь список объектов — агент щёлкал по «1» и
-- получал девятнадцать строк, ни одна из которых не помечена.
--
-- Поэтому главная проверка здесь одна: ЦИФРА НА СВОДКЕ РАВНА ЧИСЛУ СТРОК В
-- СПИСКЕ, НА КОТОРЫЙ ОНА ВЕДЁТ. Два разных запроса к двум разным объектам
-- базы, и расхождение между ними выглядело бы как работающая ссылка.
--
-- Вторая проверка — про три состояния. `attention` возвращает 'critical',
-- 'warning', 'ok' или null, и последнее означает «НЕ ЗНАЕМ»: объект чужого
-- агентства, его договор нам не виден. Выдать это за «всё в порядке» —
-- ровно та ошибка, которую инвариант 37 нашёл в карточке объекта.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Второе агентство: без него проверка про «не знаем» вакуумна
-- ---------------------------------------------------------------------------
set role postgres;
set request.jwt.claims = '{}';

insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa02', 'Альфа');

insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id, directions)
values ('00000000-0000-0000-0000-0000000000f1', 'nurlan@alfa.kg', '+996700900011',
        '00000000-0000-0000-0000-0000000000e1', 'Нурлан', 'agent', 'approved',
        '00000000-0000-0000-0000-00000000aa02', '{sale}');

\set agent_alfa '00000000-0000-0000-0000-0000000000f1'
\set obj_alfa   '00000000-0000-0000-0000-0000000f0001'

insert into contacts (id, kind, name, owner_agent_id, roles, source) values
  ('00000000-0000-0000-0000-00000000c0a1', 'person', 'Собственник Альфы',
   :'agent_alfa', '{owner}', 'чужое агентство');

insert into objects (id, kind, deal_type, address, zone, rooms, area, floor, price,
                     created_by_agent_id)
values (:'obj_alfa', 'flat', 'sale', 'Жибек Жолу 100, кв. 3', 'Центр', 2, 60.0, 4, 90000,
        :'agent_alfa');

insert into object_ownerships (object_id, contact_id, role, share) values
  (:'obj_alfa', '00000000-0000-0000-0000-00000000c0a1', 'owner', 1);

insert into mandates (object_id, kind, valid_from, valid_to, start_price,
                      listing_agent_id, contract_confirmed, status)
values (:'obj_alfa', 'exclusive', current_date - 10, current_date + 80, 95000,
        :'agent_alfa', true, 'active');

update objects set publication_state = 'published' where id = :'obj_alfa';

-- Чужой объект СВЕЖИЙ нарочно: если бы он сам попал в отчёт, проверка «у
-- чужого внимание не определено» прошла бы по другой причине.
update objects set actual_at = now() where id = :'obj_alfa';

-- ---------------------------------------------------------------------------
-- Свой объект, подвисший до «срочно»
-- ---------------------------------------------------------------------------
-- Сдвинуть actual_at назад нельзя: его ставит триггер инварианта 5, и правка
-- столбца молча не применяется — проверено, первая версия этого теста именно
-- на этом и провалилась. Значит объект заводится сразу с нужной давностью: на
-- вставке значение принимается.
--
-- Порог: app.stale_after_days() = 14, «срочно» — больше чем вдвое. Берём 40
-- дней, чтобы проверка не ломалась от изменения порога на день.
\set obj_stale '00000000-0000-0000-0000-0000000fa001'

insert into objects (id, kind, deal_type, address, zone, price, actual_at,
                     created_by_agent_id)
values (:'obj_stale', 'flat', 'sale', 'Подвисший 1, кв. 1', 'Центр', 60000,
        now() - interval '40 days', :'agent_aibek');

insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_stale', :'contact_owner', 'owner', 1);

insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_stale', 'non_exclusive', 60000, :'agent_aibek', true, 'active');

update objects set publication_state = 'published' where id = :'obj_stale';

-- ---------------------------------------------------------------------------
-- Свой объект БЕЗ замечаний
-- ---------------------------------------------------------------------------
-- Нужен, потому что в сценарии приёмки такого нет ни одного: у всех объектов
-- нет фотографий, то есть все попадают в отчёт предупреждением. Проверка
-- «„всё в порядке“ не ставится чужим» без него сравнивала ноль с нулём —
-- страховка от вакуума это и поймала.
--
-- Чтобы замечаний не было ни одного, объекту нужно всё сразу: договор без
-- срока (значит не истекает), свежее подтверждение, фотография, публикация
-- (иначе причина «не опубликован») и малая давность публикации (иначе
-- «в каталоге давно, показов нет», порог 30 дней).
\set obj_clean '00000000-0000-0000-0000-0000000fa002'

insert into objects (id, kind, deal_type, address, zone, price, created_by_agent_id)
values (:'obj_clean', 'flat', 'sale', 'Без замечаний 2, кв. 2', 'Центр', 70000,
        :'agent_aibek');

insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_clean', :'contact_owner', 'owner', 1);

insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_clean', 'non_exclusive', 70000, :'agent_aibek', true, 'active');

insert into object_photos (object_id, storage_key, content_type, uploaded_by_agent_id)
values (:'obj_clean',
        'objects/00000000-0000-0000-0000-0000000fa002/00112233445566778899aabbccddeeff.webp',
        'image/webp', :'agent_aibek');

update objects set publication_state = 'published' where id = :'obj_clean';

set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- ---------------------------------------------------------------------------
-- Главное: цифра ведёт туда, что посчитала
-- ---------------------------------------------------------------------------

select test.ok(
  (select objects_critical from my_alerts_v) > 0,
  'в сводке есть хотя бы один срочный объект: иначе всё ниже вакуумно');

-- Сводка считает СВОИ объекты (миграция 0051), поэтому и список берётся
-- свой: плитка ведёт на /cabinet/objects?attention=critical&source=mine.
select test.eq(
  (select count(*)::int from app.search_objects('mine', p_attention => 'critical')),
  (select objects_critical from my_alerts_v),
  'цифра «требуют внимания срочно» равна числу строк в списке, на который ведёт');

select test.eq(
  (select count(*)::int from app.search_objects(p_attention => 'any')),
  (select count(*)::int from stale_objects_v),
  '«есть что-то» показывает ровно столько, сколько строк в отчёте');

select test.eq(
  (select count(*)::int from app.search_objects(p_attention => 'critical')
    where attention is distinct from 'critical'),
  0,
  'фильтр «срочно» не приводит предупреждения');

select test.eq(
  (select count(*)::int from app.search_objects(p_attention => 'warning')
    where attention is distinct from 'warning'),
  0,
  'фильтр «предупреждение» не приводит срочные');

-- Фильтр СУЖАЕТ, а не открывает: это уже свойство инварианта 37, и новый
-- параметр не должен его нарушить.
select test.ok(
  (select count(*)::int from app.search_objects(p_attention => 'any'))
    <= (select count(*)::int from app.search_objects()),
  'фильтр внимания только сужает список');

-- ---------------------------------------------------------------------------
-- Цифра про то, что могу сделать Я
-- ---------------------------------------------------------------------------
-- Подвисший объект КОЛЛЕГИ не попадает в мою цифру: кнопок действия у чужой
-- строки нет, и число, зовущее туда, где я бессилен, — это то же враньё, что
-- число, не требующее действия вовсе. Объект при этом не теряется: он
-- считается у того, кто за него отвечает.
-- Клеймы сбрасываются вместе с ролью: без этого auth.uid() остаётся Айбеком,
-- и инвариант 22 справедливо отказывает — «объект ведёт агент действующего
-- договора», а тут Айбек заводил бы объект Бакыта. Первая версия этого блока
-- на том и упала.
set role postgres;
set request.jwt.claims = '{}';
\set obj_bakyt '00000000-0000-0000-0000-0000000fa003'
insert into objects (id, kind, deal_type, address, zone, price, actual_at,
                     created_by_agent_id)
values (:'obj_bakyt', 'flat', 'sale', 'Подвисший у коллеги 3', 'Центр', 50000,
        now() - interval '40 days', :'agent_bakyt');
insert into object_ownerships (object_id, contact_id, role, share)
values (:'obj_bakyt', :'contact_owner', 'owner', 1);
insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values (:'obj_bakyt', 'non_exclusive', 50000, :'agent_bakyt', true, 'active');
update objects set publication_state = 'published' where id = :'obj_bakyt';
set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.eq(
  (select severity from stale_objects_v where object_id = :'obj_bakyt'),
  'critical',
  'объект коллеги подвис по-настоящему: проверка ниже не вакуумна');

select test.eq(
  (select attention from app.search_objects() where object_id = :'obj_bakyt'),
  'critical',
  'и в списке он виден как срочный: скрывать чужую беду незачем');

select test.eq(
  (select count(*)::int from app.search_objects('mine', p_attention => 'critical')
    where object_id = :'obj_bakyt'),
  0,
  'но в МОЮ цифру он не входит: действовать по нему не мне');

select test.eq(
  (select count(*)::int from app.search_objects('mine', p_attention => 'critical')),
  (select objects_critical from my_alerts_v),
  'цифра и список сходятся и после появления чужого подвисшего');

set request.jwt.claims = :'claims_bakyt';
select test.ok(
  (select objects_critical from my_alerts_v) > 0,
  'у коллеги на его сводке этот объект есть: он не потерялся');
set request.jwt.claims = :'claims_aibek';

-- ---------------------------------------------------------------------------
-- Три состояния, а не два
-- ---------------------------------------------------------------------------

select test.eq(
  (select count(*)::int from app.search_objects() where object_id = :'obj_alfa'),
  1,
  'объект чужого агентства в списке виден: проверка ниже не вакуумна');

select test.ok(
  (select attention from app.search_objects() where object_id = :'obj_alfa') is null,
  'у чужого объекта внимание НЕ ОПРЕДЕЛЕНО: его договор нам не виден');

select test.ok(
  (select attention from app.search_objects() where object_id = :'obj_alfa')
    is distinct from 'ok',
  'и это не «всё в порядке»: пустой ответ политики — не утверждение');

select test.eq(
  (select attention from app.search_objects() where object_id = :'obj_stale'),
  'critical',
  'свой подвисший объект назван срочным');

select test.ok(
  (select count(*)::int from app.search_objects()
    where attention = 'ok' and source = 'other') = 0,
  '«всё в порядке» не ставится чужим объектам ни при каких данных');

select test.eq(
  (select attention from app.search_objects() where object_id = :'obj_clean'),
  'ok',
  'свой объект без замечаний назван «всё в порядке»: проверка выше не вакуумна');

-- Состояний ровно четыре, и они покрывают всё: иначе где-то появилось пятое
-- значение, и вёрстка о нём не знает.
select test.eq(
  (select count(*)::int from app.search_objects()
    where attention is null or attention in ('critical', 'warning', 'ok')),
  (select count(*)::int from app.search_objects()),
  'других значений внимания не бывает');

-- ---------------------------------------------------------------------------
-- Причины: список внимания без причины — это тупик
-- ---------------------------------------------------------------------------
-- Агент приходит сюда со сводки, чтобы понять, ЧТО делать. Строка без
-- причины отправляет его открывать карточку и догадываться.

select test.eq(
  (select count(*)::int from app.search_objects(p_attention => 'any')
    where attention_reasons is null or cardinality(attention_reasons) = 0),
  0,
  'у каждой строки в списке внимания названа причина');
