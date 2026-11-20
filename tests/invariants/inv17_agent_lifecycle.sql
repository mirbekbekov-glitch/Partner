-- ИНВАРИАНТ 17. Агент работает только по решению администратора, сам себе
--               прав не выдаёт, и хотя бы один действующий администратор в
--               агентстве остаётся всегда.
--
-- Этот тест появился из дыры, а не из замысла. До 0021 обычный одобренный
-- агент становился администратором одним запросом:
--
--     update agents set role = 'admin' where auth_user_id = auth.uid();
--
-- Политика agents_self_update разрешала править «свою строку», а строки в RLS
-- не делятся на столбцы. Поэтому ниже проверяется не только то, что одобрение
-- работает, но и то, что его нельзя выдать себе — тремя разными способами.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 17а. Агент не выдаёт себе прав ---------------------------------------
-- Первый слой — права на столбцы. RLS столбцов не различает, грант различает.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.throws(
  $$update agents set role = 'admin' where auth_user_id = auth.uid()$$,
  'permission denied for table agents',
  'агент не назначает себе роль');

select test.throws(
  $$update agents set status = 'approved' where auth_user_id = auth.uid()$$,
  'permission denied for table agents',
  'агент не меняет себе статус');

select test.throws(
  $$update agents set phone = '+996700000000' where auth_user_id = auth.uid()$$,
  'permission denied for table agents',
  'агент не меняет себе телефон: это ключ личности, его меняют подтверждением');

-- Имя и Telegram — своё дело агента.
update agents set full_name = 'Бакыт Бакытов' where auth_user_id = auth.uid();
select test.eq((select full_name from me_v), 'Бакыт Бакытов',
  'имя агент меняет сам');

select test.eq(app.is_admin(), false, 'после всех попыток агент не администратор');

-- ---- 17б. Чужого агента тоже не одобрить ----------------------------------
select test.throws(
  format($$select approve_agent(%L)$$, :'agent_chyngyz'),
  'FORBIDDEN: агентов одобряет администратор',
  'агент не одобряет других агентов');
select test.throws(
  format($$select set_agent_role(%L, 'admin')$$, :'agent_bakyt'),
  'FORBIDDEN: роли назначает администратор',
  'агент не назначает роли');
select test.throws(
  format($$select block_agent(%L)$$, :'agent_aibek'),
  'FORBIDDEN: агентов блокирует администратор',
  'агент не блокирует других агентов');

-- ---- 17в. Триггер держит правило и в обход прав на столбцы ----------------
-- Второй слой. Функции security definer права на столбцы обходят, поэтому
-- любая будущая функция, забывшая проверку админа, упрётся в триггер.
set role postgres;
create or replace function app.sloppy_promote(p_agent_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Нарочно без проверки администратора: так выглядит забытая проверка.
  update agents set role = 'admin' where id = p_agent_id;
end $$;
grant execute on function app.sloppy_promote(uuid) to authenticated;

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select app.sloppy_promote(%L)$$, :'agent_bakyt'),
  'INVARIANT_17: статус и роль агента меняет только администратор',
  'забывшую проверку функцию останавливает триггер');

set role postgres;
drop function app.sloppy_promote(uuid);

-- ---- 17г. Администратор одобряет, и это работает --------------------------
-- Инвариант про запреты легко «выполнить», запретив всё. Поэтому рядом —
-- проверка, что кабинет вообще открывается.
set role authenticated;
set request.jwt.claims = :'claims_pending';

select test.eq((select count(*)::int from me_v), 1,
  'неодобренный агент видит себя: иначе кабинету нечего ему показать');
select test.eq((select status::text from me_v), 'pending',
  'и видит, что ждёт одобрения');
-- Опубликованные объекты неодобренный агент видит — это публичный каталог,
-- и видит их любой посетитель. Первая версия теста утверждала обратное и
-- падала: проверять надо внутреннее, а не каталог.
select test.eq((select count(*)::int from contacts), 0,
  'но контактов не видит');
select test.eq((select count(*)::int from mandates), 0,
  'и мандатов не видит');
select test.throws(
  $$select app.require_agent()$$,
  'FORBIDDEN: требуется одобренный агент',
  'и ни одной операции кабинета ему не выполнить');

-- Своя строка — это своя строка, а не весь состав агентства. Мутация,
-- заменявшая условие политики на «истина», выживала: ни одно утверждение не
-- спрашивало, сколько именно агентов видит неодобренный.
select test.eq((select count(*)::int from agents), 1,
  'неодобренный агент видит ровно одну строку: свою');

set request.jwt.claims = :'claims_admin';
select test.eq((select status from approve_agent(:'agent_chyngyz')), 'approved'::agent_status,
  'администратор одобряет агента');

-- ---- 17д. Последний администратор не исчезает -----------------------------
-- Третий слой. Без него агентство запирает себя снаружи: разжаловали
-- единственного админа — и одобрять новых агентов стало некому вообще.
select test.throws(
  format($$select set_agent_role(%L, 'agent')$$, :'agent_admin'),
  'INVARIANT_17: в агентстве должен остаться хотя бы один действующий администратор',
  'единственного администратора не разжаловать');

select test.throws(
  format($$select block_agent(%L)$$, :'agent_admin'),
  'INVARIANT_17: себя заблокировать нельзя',
  'себя администратор не блокирует');

-- Со вторым администратором первого разжаловать уже можно: правило защищает
-- агентство от запирания, а не конкретного человека от понижения.
select test.eq((select role from set_agent_role(:'agent_bakyt', 'admin')), 'admin'::agent_role,
  'второй администратор назначен');
select test.eq((select role from set_agent_role(:'agent_admin', 'agent')), 'agent'::agent_role,
  'при двух администраторах одного можно разжаловать');

-- И теперь правило снова держит: Бакыт остался единственным.
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select set_agent_role(%L, 'agent')$$, :'agent_bakyt'),
  'INVARIANT_17: в агентстве должен остаться хотя бы один действующий администратор',
  'последний администратор не разжалует и сам себя');

-- ---- 17е. Удаление последнего администратора тоже запрещено ---------------
-- Прав на delete у роли приложения нет, но правило не должно зависеть от
-- того, что кто-то не выдал грант.
set role postgres;
select test.throws(
  format($$delete from agents where id = %L$$, :'agent_bakyt'),
  'INVARIANT_17: в агентстве должен остаться хотя бы один действующий администратор',
  'последнего администратора не удалить даже владельцем базы');

-- ---- 17ж. Каталогу состав агентства недоступен ----------------------------
set role anon;
select test.throws(
  $$select * from agency_agents_v$$,
  'permission denied for view agency_agents_v',
  'аноним не видит состав агентства');
select test.throws(
  format($$select approve_agent(%L)$$, :'agent_chyngyz'),
  'permission denied for function approve_agent',
  'аноним не одобряет агентов');
