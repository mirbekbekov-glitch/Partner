-- Экран профиля (миграция 0013).
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ===========================================================================
-- Свою строку агент видит, даже пока не одобрен
-- ===========================================================================

set request.jwt.claims = :'claims_pending';
set role authenticated;

select test.eq(test.visible_count($$select 1 from agents where auth_user_id = auth.uid()$$),
  1::bigint, 'неодобренный агент видит СВОЮ строку');
select test.eq((select status from agents where auth_user_id = auth.uid()),
  'pending'::agent_status, 'и видит свой статус — кабинету есть что объяснить');

-- Но только свою: о коллегах он по-прежнему не знает ничего.
select test.eq(test.visible_count($$select 1 from agents$$), 1::bigint,
  'неодобренный агент видит ровно одну строку — себя');
select test.eq(test.visible_count(format($$select 1 from agents where id = %L$$, :'agent_aibek')),
  0::bigint, 'чужую строку неодобренный не видит');

-- ===========================================================================
-- Правка своего профиля
-- ===========================================================================

select * from update_my_profile('Эржан Асанов'::text, ' +996 700 12 34 56 '::text) \gset p_
select test.eq(:'p_full_name'::text, 'Эржан Асанов', 'неодобренный агент вписал себе имя');
select test.eq(:'p_phone'::text, '+996 700 12 34 56', 'телефон записан без краевых пробелов');

-- Пустая строка телефона — это «телефона нет».
select * from update_my_profile('Эржан Асанов'::text, '   '::text) \gset p2_
select test.ok((select phone is null from agents where auth_user_id = '00000000-0000-0000-0000-0000000000b4'),
  'пустая строка телефона превращается в NULL, а не в пустой телефон');

-- Имя стереть нельзя: иначе на экране одобрения опознавать некого.
select test.throws(
  $$select update_my_profile('   ')$$,
  'Имя не может быть пустым',
  'имя нельзя стереть через функцию');
select test.throws(
  $$update agents set full_name = '' where auth_user_id = auth.uid()$$,
  'agents_full_name_not_blank',
  'имя нельзя стереть и прямым UPDATE');

-- ===========================================================================
-- Чужой профиль недосягаем
-- ===========================================================================
-- Функция идентификатор агента не принимает, поэтому обращаться к чужой
-- строке ей просто нечем. Прямой UPDATE отбивает политика.

select test.eq(test.visible_count(format($$
  select 1 from agents where id = %L and full_name = 'Эржан Асанов'$$, :'agent_aibek')),
  0::bigint, 'правка своего профиля чужую строку не задела');

-- Здесь нельзя ждать ошибки: колонка full_name агенту выдана грантом, а
-- политика чужую строку просто не находит. UPDATE на 0 строк исключения не
-- бросает, поэтому проверяем результат, а не отказ.
update agents set full_name = 'Взлом' where id = :'agent_aibek';
reset role;
select test.eq((select full_name from agents where id = :'agent_aibek'),
  'Айбек', 'чужое имя прямым UPDATE не переписалось: политика строку не нашла');

set request.jwt.claims = :'claims_pending';
set role authenticated;

-- Регрессия на 0011: через путь профиля статус и роль тоже не достать.
select test.throws(
  $$update agents set status = 'approved' where auth_user_id = auth.uid()$$,
  'permission denied',
  'путь профиля не даёт переписать себе статус');
select test.ok(app.current_agent_id() is null,
  'после правки профиля агент всё ещё не одобрен');
reset role;

-- ===========================================================================
-- Одобренный агент: профиль работает так же
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select * from update_my_profile('Айбек Орозов'::text, '+996555111222'::text) \gset a_
select test.eq(:'a_full_name'::text, 'Айбек Орозов', 'одобренный агент правит свой профиль');
-- И по-прежнему видит коллег: политика только добавила самочтение.
select test.ok(test.visible_count($$select 1 from agents$$) > 1,
  'одобренный агент как и раньше видит всех агентов');
reset role;

-- ===========================================================================
-- Заблокированный видит, что заблокирован
-- ===========================================================================
set request.jwt.claims = :'claims_admin';
set role authenticated;
select app.block_agent(:'agent_chyngyz');
reset role;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq((select status from agents where auth_user_id = auth.uid()),
  'blocked'::agent_status,
  'заблокированный агент видит свой статус — кабинет может сказать, что доступ отозван');
select test.eq(test.visible_count($$select 1 from requirements$$), 0::bigint,
  'при этом CRM ему закрыта');
reset role;

-- ===========================================================================
-- Без сессии профиль не правится
-- ===========================================================================
reset request.jwt.claims;
select test.throws(
  $$select update_my_profile('Никто')$$,
  'FORBIDDEN',
  'без сессии профиль не правится');
