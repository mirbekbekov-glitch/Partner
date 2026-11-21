-- ИНВАРИАНТ 15. Ни одна функция схемы app не вызывается кем попало,
--               и у каждой роли ровно те права, что ей нужны.
--
-- Этот тест устроен иначе, чем остальные. Остальные проверяют, что нужное
-- РАБОТАЕТ; этот проверяет, что лишнего НЕТ. Разница видна на истории: все
-- 362 утверждения были зелёными, пока anon мог удалить пул кандидатов, —
-- потому что ни одно не спрашивало, чего он не может.
--
-- Проверка не перечисляет функции по именам: она смотрит на схему целиком.
-- Поэтому её провалит и та миграция, которой ещё нет.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_admin';

-- ---- 15а. PUBLIC не вызывает ничего --------------------------------------
select test.eq(
  (select count(*)::int from app.functions_open_to_public()),
  0, 'ни одной нашей функции, открытой PUBLIC');

-- Схем две: app и public. Функции кабинета живут в public, и до инварианта 15
-- все они были доступны роли anon. Дыры при этом не было — каждая начинается
-- с проверки агента, — но защита держалась на том, что ни один автор об этой
-- строке не забудет. Проверка агента осталась вторым слоем, первым стало
-- право вызова.
select test.ok(
  (select count(*) from app.functions_open_to_public() where schema_name = 'public') = 0,
  'в схеме public тоже не осталось функций, открытых PUBLIC');

-- Сообщение называет виновных: без этого провал будет загадкой.
select test.ok(
  (select string_agg(function_name, ', ') from app.functions_open_to_public()) is null,
  'список открытых функций пуст');

-- ---- 15а-бис. Проверка видит и функцию, которой никто не выдавал прав ----
-- В Postgres пустой proacl означает не «прав ни у кого», а «права по
-- умолчанию», то есть EXECUTE у PUBLIC. Функция, созданная и забытая, выглядит
-- в каталоге чистой — и именно так дыра и появилась. Мутационный тест показал,
-- что без этой проверки обработку пустого proacl можно убрать незаметно.
set role postgres;
create function app.forgotten_function() returns integer
  language sql immutable as $$ select 1 $$;
create function public.forgotten_cabinet_function() returns integer
  language sql immutable as $$ select 1 $$;

select test.eq(
  (select count(*)::int from app.functions_open_to_public()
    where function_name = 'forgotten_function'),
  1, 'функция схемы app без единого гранта считается открытой PUBLIC');

select test.eq(
  (select count(*)::int from app.functions_open_to_public()
    where function_name = 'forgotten_cabinet_function'),
  1, 'функция схемы public без единого гранта тоже считается открытой');

drop function app.forgotten_function();
drop function public.forgotten_cabinet_function();

select test.eq(
  (select count(*)::int from app.functions_open_to_public()),
  0, 'после уборки снова ни одной открытой функции');

-- ---- 15б. Каталогу открыты ровно две функции ------------------------------
-- Посетитель каталога — это роль anon. Ей нужны отчёт собственника по ссылке
-- и определение агента, иначе каталог не читается. Плюс кабинет собственника
-- с приостановкой показов (инвариант 29): по ту сторону собственник с
-- токеном, а не вошедший агент. Плюс три функции фида
-- (инвариант 28): по ту сторону ссылки площадка, а не вошедший агент, и
-- отдаёт ей тот же публичный каталог. Ни таблиц, ни чего-либо сверх
-- публичного роль при этом не получает. Больше ничего.
set role postgres;
select test.eq(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and has_function_privilege('anon', p.oid, 'execute')),
  array['channel_feed', 'current_agent_id', 'feed_settings',
        'owner_cabinet', 'owner_pause', 'owner_report', 'record_channel_fetch'],
  'анониму открыты ровно семь функций схемы app и ни одной больше');

-- Из схемы public анониму не открыто ничего: отчёт собственника по ссылке —
-- это app.owner_report() выше, и кабинетных функций в этом списке быть не
-- должно ни одной.
select test.eq(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d
                       where d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'execute')),
  0, 'из схемы public анониму не открыто ни одной нашей функции');

-- ---- 15в. Сборщику открыты ровно две функции ------------------------------
-- Контракт из collector/README.md: приём объявления и отметка исчезнувших.
select test.eq(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and has_function_privilege('collector', p.oid, 'execute')),
  array['mark_candidates_gone', 'upsert_candidate'],
  'сборщику открыты ровно две функции');

-- ---- 15в-бис. Таблицы и представления, открытые на чтение ----------------
-- Функции — половина поверхности. Вторая половина это таблицы: PostgREST
-- отдаёт их напрямую, и каждое новое представление по умолчанию никому не
-- выдано, но выдать его «на всякий случай» ничего не стоит. Поэтому список
-- читаемого анонимом перечислен здесь целиком, а не проверяется по одному.
--
-- objects в списке не случайно: public_catalog_v собрано с security_invoker,
-- то есть читается правами вызывающего, и без select на objects каталог не
-- работал бы. Строки при этом ограничивает RLS — это инвариант 4.
select test.eq(
  (select array_agg(c.relname::text order by c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
      and has_table_privilege('anon', c.oid, 'select')),
  array['objects', 'public_catalog_v', 'public_photo_v'],
  'аноним читает ровно каталог, фотографии и объекты под RLS');

-- Сборщику чтение не нужно вовсе: он только приносит объявления.
select test.eq(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
      and has_table_privilege('collector', c.oid, 'select')),
  0, 'сборщик не читает ни одной таблицы');

-- ---- 15г. То же самое, но вызовом ------------------------------------------
-- Права в каталоге и права на деле — разные вещи: функция могла оказаться
-- доступной через другую. Поэтому запрещённое проверяется вызовом.
set role anon;
select test.throws(
  'select app.purge_candidates()',
  'permission denied for function purge_candidates',
  'аноним не удаляет кандидатов');
select test.throws(
  $$select app.upsert_candidate('{"source":"manual","external_id":"X"}'::jsonb)$$,
  'permission denied for function upsert_candidate',
  'аноним не пишет в пул кандидатов');

set role postgres; set role collector;
select test.throws(
  'select app.purge_candidates()',
  'permission denied for function purge_candidates',
  'сборщик не удаляет кандидатов');
select test.throws(
  'select app.release_stale_claims()',
  'permission denied for function release_stale_claims',
  'сборщик не снимает закрепления агентов');

-- ---- 15д. Агенту нужное доступно ------------------------------------------
-- Инвариант про лишние права легко «выполнить», отняв всё. Поэтому рядом
-- проверка, что кабинет работает.
set role postgres; set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.ok(
  (select count(*) from app.purge_candidates()) = 1,
  'агенту очистка доступна: она часть кабинета, а не службы');
