-- ИНВАРИАНТ 38. Лицо и аттестация агента.
--
--   а. Номер сертификата ТПП — заявление агента. Сам по себе он ничего не
--      доказывает, и состояние у него своё: «заявлен».
--   б. Подтверждает администратор ПЛАТФОРМЫ. Ни сам агент, ни руководитель
--      его агентства: руководитель подтверждал бы сам себе.
--   в. Смена номера или дат сбрасывает подтверждение. Иначе путь очевиден:
--      подать настоящий номер, дождаться сверки, подменить на любой.
--   г. Срок — факт, а не статус: «истёк» вычисляется из даты и нигде не
--      хранится. И «истёк» — это не «нет».
--   д. Номер уникален: два агента с одним номером означают, что один врёт.
--   е. Чужой номер наружу не отдаётся — отдаётся ответ «в реестре или нет».
--   ж. Аватар идёт по той же трубе, что фотографии объекта (инвариант 11):
--      форма ключа ограничена схемой, и клиентские страницы его не видят.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role postgres;
set request.jwt.claims = '{}';

-- Второе агентство: без него «руководитель не подтверждает» проверялось бы
-- на данных, где руководителя рядом нет.
insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa02', 'Альфа');
insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id)
values ('00000000-0000-0000-0000-0000000000f1', 'nurlan@alfa.kg', '+996700900011',
        '00000000-0000-0000-0000-0000000000e1', 'Нурлан', 'agent', 'approved',
        '00000000-0000-0000-0000-00000000aa02');
\set claims_alfa '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}'
\set agent_alfa  '00000000-0000-0000-0000-0000000000f1'

-- Айбек — руководитель своего агентства. Именно он не должен мочь.
update agents set role = 'head' where id = :'agent_aibek';

-- ===========================================================================
-- 38а. Номер — это заявление
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.eq(
  (select certificate_state from me_v), 'нет',
  'без номера аттестации нет');

update agents
   set certificate_no = 'ТПП-0421',
       certificate_issued_on = current_date - 30,
       certificate_valid_to  = current_date + 1795
 where id = app.current_agent_id();

select test.eq(
  (select certificate_state from me_v), 'заявлен',
  'заявленный номер — это «заявлен», а не «подтверждён»');

select test.eq(
  app.is_certified(:'agent_bakyt'), false,
  'заявленный номер не делает агента «в реестре»');

-- ===========================================================================
-- 38б. Подтверждает администратор платформы
-- ===========================================================================
select test.throws(
  'update agents set certificate_confirmed_at = now() where id = app.current_agent_id()',
  'permission denied',
  'агент не может подтвердить аттестацию сам: это не его столбец');

select test.throws(
  format('select confirm_certificate(%L)', :'agent_bakyt'),
  'INVARIANT_38',
  'и через функцию тоже не может');

set request.jwt.claims = :'claims_aibek';
select test.throws(
  format('select confirm_certificate(%L)', :'agent_bakyt'),
  'INVARIANT_38',
  'руководитель своего агентства аттестацию не подтверждает');

-- Триггер — второй слой под грантами: функция с правами определителя или
-- миграция грантов не спрашивает, и правило обязано стоять и там.
set role postgres;
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format('update agents set certificate_confirmed_at = now() where id = %L', :'agent_bakyt'),
  'INVARIANT_38',
  'и прямым UPDATE в обход грантов — тоже');

set role authenticated;
set request.jwt.claims = :'claims_admin';
-- Скобки и .id не для красоты: `составная_строка is not null` истинно лишь
-- когда НИ ОДНО поле не NULL, и первая версия этой проверки падала на
-- пустом blocked_reason, а не на правиле.
select (confirm_certificate(:'agent_bakyt')).certificate_confirmed_at is not null as ok \gset conf_
select test.ok(:'conf_ok', 'администратор платформы аттестацию подтвердил');

select test.eq(
  app.is_certified(:'agent_bakyt'), true,
  'после сверки агент в реестре');

select test.eq(
  (select confirmed_by_name from certificate_queue_v where agent_id = :'agent_bakyt'),
  'Админ',
  'подтвердивший выведен, а не принят запросом');

select test.throws(
  format('select confirm_certificate(%L)', :'agent_alfa'),
  'INVARIANT_38',
  'подтверждать нечего, пока номер не заявлен');

-- Подтвердивший ВЫВОДИТСЯ, а не принимается: передать в запросе чужого
-- нельзя. Поле, которое нельзя передать неправильно, надёжнее проверяемого.
set role postgres;
set request.jwt.claims = '{}';
update agents set certificate_no = 'ТПП-0777' where id = :'agent_alfa';
set request.jwt.claims = :'claims_admin';
update agents
   set certificate_confirmed_at = now(),
       certificate_confirmed_by = :'agent_bakyt'
 where id = :'agent_alfa';
set role authenticated;
select test.eq(
  (select certificate_confirmed_by from agents where id = :'agent_alfa'),
  :'agent_admin'::uuid,
  'подтвердившим записан тот, кто подтвердил, а не тот, кого передали');
set role postgres;
set request.jwt.claims = '{}';
update agents set certificate_confirmed_at = null, certificate_confirmed_by = null
 where id = :'agent_alfa';
set role authenticated;
set request.jwt.claims = :'claims_admin';

-- Снятие аттестации — тоже решение администратора, и у него обязана быть
-- причина: её прочитает агент.
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format('select revoke_certificate(%L, %L)', :'agent_bakyt', 'передумал'),
  'INVARIANT_38',
  'снять аттестацию агент сам не может');
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format('select revoke_certificate(%L, %L)', :'agent_bakyt', 'передумал'),
  'INVARIANT_38',
  'и руководитель агентства тоже');
set request.jwt.claims = :'claims_admin';
select test.throws(
  format('select revoke_certificate(%L, %L)', :'agent_bakyt', '  '),
  'INVARIANT_38',
  'снятие без причины не проходит');

-- ===========================================================================
-- 38в. Смена номера сбрасывает подтверждение
-- ===========================================================================
set request.jwt.claims = :'claims_bakyt';

update agents set certificate_no = 'ТПП-9999' where id = app.current_agent_id();

select test.eq(
  (select certificate_state from me_v), 'заявлен',
  'подмена номера сбрасывает подтверждение');

select test.eq(
  app.is_certified(:'agent_bakyt'), false,
  'и из реестра агент при этом выпадает');

select test.eq(
  (select certificate_confirmed_by from agents where id = app.current_agent_id()),
  null::uuid,
  'вместе с подтверждением уходит и подтвердивший');

-- Даты — часть того же заявления: продлить срок молча тоже нельзя.
set request.jwt.claims = :'claims_admin';
select (confirm_certificate(:'agent_bakyt')).certificate_confirmed_at is not null as ok \gset c2_
set request.jwt.claims = :'claims_bakyt';
update agents set certificate_valid_to = current_date + 3650
 where id = app.current_agent_id();
select test.eq(
  (select certificate_state from me_v), 'заявлен',
  'продление срока своей рукой тоже сбрасывает подтверждение');

-- ===========================================================================
-- 38г. Срок — факт, а не статус
-- ===========================================================================
select test.eq(
  app.certificate_state('ТПП-1', now(), current_date + 10), 'подтверждён',
  'сверенный и не истёкший — подтверждён');

select test.eq(
  app.certificate_state('ТПП-1', now(), current_date - 1), 'истёк',
  'вчерашний срок — «истёк», и это считается из даты');

select test.eq(
  app.certificate_state(null, now(), current_date + 10), 'нет',
  'без номера — «нет», что бы ни стояло в остальных полях');

-- «Истёк» — не «нет»: коллеге важна разница между «не проходил» и
-- «проходил, пора продлевать».
select test.ok(
  app.certificate_state('ТПП-1', now(), current_date - 1)
  <> app.certificate_state(null, null, null),
  '«истёк» и «нет» — разные ответы');

-- Срок ставится ПЕРЕД сверкой, а не вместе с ней: любое изменение
-- заявленного сбрасывает подтверждение, в том числе в одном операторе с
-- ним. Первая версия проверки ставила дату и подтверждение вместе и
-- получала «заявлен» — правило сработало, а проверка была неправильной.
set request.jwt.claims = :'claims_bakyt';
update agents set certificate_valid_to = current_date - 1
 where id = app.current_agent_id();
set request.jwt.claims = :'claims_admin';
select (confirm_certificate(:'agent_bakyt')).certificate_confirmed_at is not null as ok \gset c3_

set request.jwt.claims = :'claims_bakyt';
select test.eq(
  app.is_certified(:'agent_bakyt'), false,
  'истёкший сертификат в реестре не считается');
select test.eq(
  (select certificate_state from me_v), 'истёк',
  'и на экране он назван истёкшим, а не отсутствующим');

-- ===========================================================================
-- 38д. Один сертификат — один агент
-- ===========================================================================
set role postgres;
set request.jwt.claims = '{}';
select test.throws(
  format('update agents set certificate_no = %L where id = %L', 'ТПП-9999', :'agent_chyngyz'),
  'agents_certificate_no_idx',
  'чужой номер занять нельзя');

select test.throws(
  format('update agents set certificate_no = %L where id = %L', 'тпп-9999', :'agent_chyngyz'),
  'agents_certificate_no_idx',
  'и другим регистром — тоже');

-- ===========================================================================
-- 38е. Чужой номер наружу не отдаётся
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'claims_alfa';

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'platform_agents_v' and column_name = 'certificate_no'),
  0,
  'номера чужого сертификата в списке агентов платформы нет');

select test.eq(
  (select certified from platform_agents_v where id = :'agent_bakyt'), false,
  'а ответ «в реестре или нет» — есть');

select test.eq(
  (select certificate_state from platform_agents_v where id = :'agent_bakyt'), 'истёк',
  'и состояние словами тоже');

select test.eq(
  test.visible_count(format('select 1 from agents where id = %L', :'agent_bakyt')),
  0::bigint,
  'при этом саму строку чужого агента политика по-прежнему не показывает');

-- ===========================================================================
-- 38ж. Аватар — та же труба, что фотографии объекта
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.throws(
  format('update agents set avatar_key = %L where id = app.current_agent_id()',
         '../../../etc/passwd'),
  'agents_avatar_key_shape',
  'ключ аватара произвольной формы база не принимает');

-- Имя файла тут настоящей длины: с коротким «deadbeef.exe» проверка
-- спотыкалась о число знаков, а не о расширение, и мутация «принимать любое
-- расширение» проходила незамеченной.
select test.throws(
  format('update agents set avatar_key = %L where id = app.current_agent_id()',
         'avatars/00000000-0000-0000-0000-0000000000a2/' || repeat('b', 32) || '.svg'),
  'agents_avatar_key_shape',
  'и не-webp тоже: svg — это код, а не картинка');

select test.throws(
  format('update agents set avatar_key = %L where id = app.current_agent_id()',
         'avatars/00000000-0000-0000-0000-0000000000a2/' || repeat('b', 32) || '.webp.html'),
  'agents_avatar_key_shape',
  'и двойное расширение тоже');

update agents
   set avatar_key = 'avatars/' || app.current_agent_id() || '/'
                    || repeat('a', 32) || '.webp'
 where id = app.current_agent_id();
select test.ok(
  (select avatar_key from me_v) is not null,
  'правильный ключ аватара принимается');

-- Клиентские страницы агента не показывают вовсе — ни лица, ни имени.
-- Это инвариант 36 и инвариант 10, и аватар их не отменяет.
select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'public_catalog_v' and column_name like '%avatar%'),
  0,
  'в публичной витрине аватара нет');

set role postgres;
set request.jwt.claims = '{}';
