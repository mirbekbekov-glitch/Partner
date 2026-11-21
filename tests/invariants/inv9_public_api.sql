-- Доступность функций кабинета через PostgREST.
--
-- Кабинет вызывает их как supabase.rpc('имя'), а PostgREST видит только
-- схему public. Функция, оставленная в app, компилируется и тестируется
-- на SQL, но из кабинета недоступна — ошибка, которую поймает только этот
-- тест либо живой прогон.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Каждое имя здесь встречается в коде кабинета как rpc('...').
select test.eq(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ensure_agent', 'approve_agent', 'block_agent',
                        'set_agent_role', 'confirm_actual', 'create_match',
                        'create_deal_from_match', 'close_deal', 'fail_deal',
                        'publish_object', 'withdraw_object')),
  11, 'все 11 функций кабинета лежат в схеме public, а не в app');

-- И роль authenticated может их выполнять.
select test.eq(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ensure_agent', 'approve_agent', 'block_agent',
                        'set_agent_role', 'confirm_actual', 'create_match',
                        'create_deal_from_match', 'close_deal', 'fail_deal',
                        'publish_object', 'withdraw_object')
      and has_function_privilege('authenticated', p.oid, 'execute')),
  11, 'роль authenticated может выполнять все 11');

-- Обёртка не ослабляет проверку прав: она у app.*, а не у обёртки.
set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
-- Сообщение именно approve_agent: общее FORBIDDEN прошло бы и от триггера.
select test.throws(
  format($$select approve_agent(%L)$$, :'agent_bakyt'),
  'одобрять агентов может только админ',
  'публичная обёртка approve_agent не обходит проверку на админа');
reset role;

-- Обёртка ensure_agent работает так же, как app-версия.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000dd01', 'wrapper@partner.kg');
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000dd01","role":"authenticated"}';
set role authenticated;
select (ensure_agent()).email as w_email \gset
select test.eq(:'w_email'::text, 'wrapper@partner.kg',
  'публичная обёртка ensure_agent создаёт агента и подхватывает почту');
reset role;

-- Внутренности схемы app наружу не выставлены.
select test.eq(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('write_audit', 'can_see_contact', 'guard_agent_privileges',
                        'jsonb_diff', 'touch_updated_at')),
  0, 'внутренние функции в public не просочились');

-- ===========================================================================
-- Публичная витрина не раскрывает, чей это объект
-- ===========================================================================
-- Решение владельца: искать объекты по агенту и агентству можно в CRM, а
-- каталогом пользуются не только агенты — внутреннее устройство агентства
-- их не касается. Правило закрепляем проверкой состава витрины, а не
-- памятью: стоит однажды добавить колонку «ведёт», и оно тихо отменится.

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'public_catalog_v'
      and (column_name like '%agent%' or column_name like '%org%'
           or column_name like '%owner%' or column_name like '%commission%')),
  0, 'в публичной витрине нет ни агента, ни агентства, ни собственника, ни комиссии');

-- А в кабинете эти сведения есть — иначе фильтр источника не на чем
-- построить.
select test.eq(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'object_list_v'
      and column_name in ('responsible_agent_id', 'responsible_org_id')),
  2, 'в списке объектов кабинета источник доступен');

-- И самой витрины анониму хватает ровно на объявления.
reset request.jwt.claims;
set role anon;
select test.throws(
  $$select count(*) from object_list_v$$,
  'permission denied for view object_list_v',
  'список объектов кабинета анониму не выдан');
reset role;
