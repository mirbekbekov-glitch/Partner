-- ИНВАРИАНТ 18. Код входа одноразовый, живёт минуты, не угадывается подбором,
--               не рассылается спамом и не лежит в базе открытым текстом.
--
-- Это первая дверь системы, открытая наружу до всякой авторизации, поэтому
-- проверяется она не «работает ли вход», а «что ещё через неё можно».
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 18а. Код живёт в базе хешем ------------------------------------------
-- Дамп базы, попавший не туда, не должен давать входа.
set role auth_service;
select code as code1 from app.issue_login_code('0555 100 200') \gset

set role postgres;
select test.eq((select count(*)::int from login_codes where code_hash = :'code1'), 0,
  'кода в открытом виде в базе нет');
select test.ok(
  (select code_hash like '$2a$%' from login_codes where phone = '+996555100200'),
  'лежит bcrypt-хеш, а не код');

-- ---- 18б. Номер нормализуется до записи -----------------------------------
-- Иначе «0555…» и «+996555…» — разные номера, и ограничение на число выдач
-- обходится сменой формата.
select test.eq((select phone from login_codes where code_hash is not null limit 1),
  '+996555100200', 'номер приведён к E.164 при выдаче');

set role auth_service;
select test.throws(
  $$select app.issue_login_code('не телефон')$$,
  'INVARIANT_18: «не телефон» не похож на номер телефона',
  'на строку, не похожую на номер, код не выдаётся');

-- ---- 18в. Код одноразовый -------------------------------------------------
-- Неудачный вход возвращается ответом, а не исключением: исключение
-- откатило бы транзакцию вместе со счётчиком попыток (см. 0022).
select test.ok((select ok from app.verify_login_code('0555100200', :'code1')),
  'код принят');
select test.eq((select reason from app.verify_login_code('0555100200', :'code1')),
  'код не запрашивался или уже использован',
  'тот же код второй раз не работает');
-- Проверяется именно ветка «код неверный», а не «кода нет»: при погашенном
-- коде ответ приходит из другой ветки, и мутация, подставляющая случайный
-- идентификатор в ответ на неверный код, оставалась незамеченной.
select code as code_live from app.issue_login_code('0555100200') \gset
select test.eq((select reason from app.verify_login_code('0555100200', '000000')),
  'код неверный', 'живой код есть, и введён он неверно');
select test.ok(
  (select auth_user_id is null from app.verify_login_code('0555100200', '000001')),
  'при неверном коде auth_user_id пуст: сессию из такого ответа не собрать');

-- ---- 18г. Новая выдача гасит прошлый код ----------------------------------
-- Иначе в живых оказывается сразу несколько кодов, и одноразовость
-- превращается в «пятиразовость».
select code as code2 from app.issue_login_code('0555100200') \gset
select code as code3 from app.issue_login_code('0555100200') \gset
-- Причина — «код неверный», а не «не запрашивался»: проверяется только
-- последний выданный код, а погашенный до сравнения уже не доходит.
select test.eq((select reason from app.verify_login_code('0555100200', :'code2')),
  'код неверный', 'предыдущий код погашен новой выдачей');

-- Погашение прошлых кодов проверяется и по состоянию таблицы, а не только по
-- отказу. Отказ приходит один и тот же независимо от того, погашен старый код
-- или просто не рассматривается, — и мутация, убиравшая погашение, выживала.
set role postgres;
select test.eq(
  (select count(*)::int from login_codes
    where phone = '+996555100200' and consumed_at is null and expires_at > now()),
  1, 'живым остаётся ровно один код на номер');
set role auth_service;
select test.ok((select ok from app.verify_login_code('0555100200', :'code3')),
  'работает только последний код');

-- ---- 18д. Подбор не проходит ----------------------------------------------
-- Шестизначный код это миллион вариантов. Без ограничения он подбирается за
-- минуты, поэтому попытки считаются, и счётчик нельзя обойти, оборвав
-- соединение: он растёт ДО сравнения кода.
select code as code4 from app.issue_login_code('0555100200') \gset

select test.eq((select reason from app.verify_login_code('0555100200','000001')),
  'код неверный', 'попытка 1 отклонена');
select test.eq((select reason from app.verify_login_code('0555100200','000002')),
  'код неверный', 'попытка 2 отклонена');
select test.eq((select reason from app.verify_login_code('0555100200','000003')),
  'код неверный', 'попытка 3 отклонена');
select test.eq((select reason from app.verify_login_code('0555100200','000004')),
  'код неверный', 'попытка 4 отклонена');
select test.eq((select reason from app.verify_login_code('0555100200','000005')),
  'код неверный', 'попытка 5 отклонена');

-- Шестая попытка не доходит до сравнения вовсе — даже с правильным кодом.
select test.eq(
  (select reason from app.verify_login_code('0555100200', :'code4')),
  'попытки исчерпаны, запросите новый код',
  'после пяти попыток не работает и правильный код');

set role postgres;
select test.eq(
  (select attempts from login_codes where phone = '+996555100200'
    order by created_at desc limit 1),
  5, 'попытки записаны: счётчик не обойти обрывом соединения');

-- ---- 18е. Спамом номер не завалить ----------------------------------------
-- Чужой номер не должен получать сообщения пачками, а счёт за WhatsApp
-- платим мы.
set role auth_service;
select app.issue_login_code('0555 300 400') \gset s1_
select app.issue_login_code('0555300400')   \gset s2_
select app.issue_login_code('0555300400')   \gset s3_
select app.issue_login_code('0555300400')   \gset s4_
select app.issue_login_code('0555300400')   \gset s5_
select test.throws(
  $$select app.issue_login_code('0555300400')$$,
  'уже отправлено 5 кодов за час',
  'шестой код за час на тот же номер не отправляется');

-- Тот же номер в другом формате — тот же номер.
select test.throws(
  $$select app.issue_login_code('+996 555 300 400')$$,
  'уже отправлено 5 кодов за час',
  'ограничение не обойти сменой формата номера');

-- ---- 18ж. Истёкший код не работает ----------------------------------------
set role postgres;
-- Назад переносится и дата создания: ограничение таблицы требует, чтобы
-- срок наступал позже создания, и выдуманная строка не должна его нарушать.
update login_codes set created_at = now() - interval '10 minutes',
                       expires_at = now() - interval '5 minutes',
                       consumed_at = null, attempts = 0
 where phone = '+996555100200';
set role auth_service;
select test.eq(
  (select reason from app.verify_login_code('0555100200', :'code4')),
  'срок кода истёк', 'код с истёкшим сроком не работает');

-- ---- 18з. Вход создаёт агента, ожидающего одобрения -----------------------
-- Связка с инвариантом 17: вошедший не получает прав, он встаёт в очередь.
set role auth_service;
select code as code5 from app.issue_login_code('0770 999 888') \gset
select auth_user_id as uid5 from app.verify_login_code('0770999888', :'code5') \gset
-- SET не принимает выражение, поэтому клеймы собираются psql, как и в
-- tests/actors.sql: это тот же путь, которым их выставит веб-сервер.
\set claims5 '{"sub":"' :uid5 '","role":"authenticated","phone":"+996770999888"}'
set request.jwt.claims = :'claims5';
select test.eq((select status from app.login_by_phone('Новый агент')), 'pending'::agent_status,
  'вошедший первым делом попадает в очередь на одобрение, а не в кабинет');

-- ---- 18и. Дверь открыта только службе входа -------------------------------
-- Выдача возвращает код вызывающему: будь она доступна каталогу, любой
-- получал бы код входа для любого номера прямо в ответе.
set role postgres; set role anon;
select test.throws(
  $$select app.issue_login_code('0555100200')$$,
  'permission denied for function issue_login_code',
  'каталог не выдаёт коды входа');
select test.throws(
  $$select app.verify_login_code('0555100200','123456')$$,
  'permission denied for function verify_login_code',
  'каталог не проверяет коды входа');

set role postgres; set role authenticated;
set request.jwt.claims = :'claims_admin';
select test.throws(
  $$select app.issue_login_code('0555100200')$$,
  'permission denied for function issue_login_code',
  'даже администратор не выдаёт коды: это дело службы входа');
select test.throws(
  $$select * from login_codes$$,
  'permission denied for table login_codes',
  'коды входа не видны даже администратору');

set role postgres; set role collector;
select test.throws(
  $$select app.issue_login_code('0555100200')$$,
  'permission denied for function issue_login_code',
  'сборщик не выдаёт коды входа');

-- ---- 18к. Служба входа не достаёт ни до чего другого ----------------------
-- Контракт роли: две функции входа, функция нормализации и сам вход. Ни
-- объектов, ни контактов, ни кандидатов.
set role postgres;
select test.eq(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and has_function_privilege('auth_service', p.oid, 'execute')),
  array['issue_login_code', 'login_by_phone', 'normalize_phone', 'verify_login_code'],
  'службе входа открыты ровно четыре функции');

select test.eq(
  (select array_agg(c.relname::text order by c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
      and has_table_privilege('auth_service', c.oid, 'select')),
  array['agents'],
  'и ровно одна таблица: агенты, которых создаёт вход');
