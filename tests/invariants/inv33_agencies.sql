-- ИНВАРИАНТ 33. Агентств много, и чужая работа чужая.
--
--   а. Клиенты, подборы, договоры и ссылки собственников принадлежат
--      агентству. Агент чужого агентства их не видит.
--   б. Сделка — исключение: в ней две стороны, и видят её оба агентства.
--      Это и есть co-broke, ради которого платформа существует.
--   в. Объект виден всем, и вместе с ним — ГЛАВНОЕ о договоре: тип и
--      подписан ли. Стартовая цена и доля агента покупателя — нет.
--   г. Инвариант 4 не ослаблен: контакт виден тому, кто его привёл, а не
--      всему его агентству.
--   д. Ждущий одобрения не получает агентства и не видит ничего.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Второе агентство и его агент
-- ---------------------------------------------------------------------------
set role postgres;
set request.jwt.claims = '{}';

insert into agencies (id, name) values
  ('00000000-0000-0000-0000-00000000aa02', 'Конкурент');

insert into agents (id, email, phone, auth_user_id, full_name, role, status, agency_id)
values ('00000000-0000-0000-0000-0000000000f1', 'rival@partner.kg', '+996700900001',
        '00000000-0000-0000-0000-0000000000e1', 'Соперник', 'agent', 'approved',
        '00000000-0000-0000-0000-00000000aa02');

\set claims_rival '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}'
\set agent_rival  '00000000-0000-0000-0000-0000000000f1'

-- ---------------------------------------------------------------------------
-- Чтобы было что прятать
-- ---------------------------------------------------------------------------
-- Без этого блока проверки ниже вакуумные: в сценарии приёмки нет ни
-- подборов, ни выданных ссылок собственникам, и «не видно ни одного»
-- проходило бы при полностью открытых политиках. Мутационная проверка
-- показала ровно это.
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj3', :'req2') \gset prep_m_

set request.jwt.claims = :'claims_aibek';
select * from issue_owner_access(:'obj1', :'contact_owner') \gset prep_oa_
select set_channel(:'obj1', 'lalafo', true) is not null as prep_ch \gset

-- ===========================================================================
-- 33а. Чужая работа не видна
-- ===========================================================================
-- До этой миграции любой одобренный агент видел всех клиентов, все подборы,
-- все договоры со стартовыми ценами и все ссылки на кабинеты собственников.
-- Это было спроектировано для одного агентства, а не недосмотром.

set role authenticated;
set request.jwt.claims = :'claims_rival';

select test.eq(
  test.visible_count('select 1 from requirements'), 0::bigint,
  'клиентов чужого агентства не видно');
select test.eq(
  test.visible_count('select 1 from matches'), 0::bigint,
  'подборов чужого агентства не видно');
select test.eq(
  test.visible_count('select 1 from mandates'), 0::bigint,
  'договоров чужого агентства не видно');
select test.eq(
  test.visible_count('select 1 from owner_access'), 0::bigint,
  'ссылок на кабинеты собственников чужого агентства не видно');
select test.eq(
  test.visible_count('select 1 from contacts'), 0::bigint,
  'контактов чужого агентства не видно');
select test.eq(
  test.visible_count('select 1 from publication_channels'), 0::bigint,
  'настроек рекламы чужого объекта не видно');

-- А свои видны: проверка не вакуумная.
set request.jwt.claims = :'claims_aibek';
select test.ok(
  test.visible_count('select 1 from mandates') > 0,
  'свои договоры видно');
select test.ok(
  test.visible_count('select 1 from requirements') > 0,
  'клиентов своего агентства видно');
select test.ok(
  test.visible_count('select 1 from matches') > 0,
  'и подборы своего агентства');
select test.ok(
  test.visible_count('select 1 from owner_access') > 0,
  'и выданные им ссылки собственникам');
select test.ok(
  test.visible_count('select 1 from publication_channels') > 0,
  'и настройки рекламы своих объектов');

-- ===========================================================================
-- 33б. Сделку видят оба агентства
-- ===========================================================================
-- Иначе мультилистинговая сделка не ведётся вовсе: одна сторона не видит
-- того, что делает другая.

-- Сначала сделка целиком внутри Liberterra: соперник в ней не участвует.
set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj2', :'req2') \gset m1_
select * from create_deal_from_match(:'m1_id') \gset d1_

set request.jwt.claims = :'claims_rival';
select test.eq(
  test.visible_count(format('select 1 from deals where id = %L', :'d1_id')),
  0::bigint,
  'чужую сделку, в которой не участвуешь, не видно');

-- А теперь настоящий co-broke: соперник ведёт СВОЕГО клиента на ЧУЖОЙ
-- объект. Сторону сделки подменить нельзя — её определяет подбор
-- (инвариант 3), и это правильно: иначе комиссию можно было бы переписать
-- одним UPDATE.
select * from create_requirement('sale'::deal_type, null, 'Клиент Соперника',
         '0555 900 001', 60000, 95000, '{Центр}', '{1,2}'::smallint[]) \gset rr_
select * from create_match(:'obj1', :'rr_id') \gset m2_
select * from create_deal_from_match(:'m2_id') \gset d2_

select test.eq(
  test.visible_count(format('select 1 from deals where id = %L', :'d2_id')),
  1::bigint,
  'свою сторону общей сделки видно');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  test.visible_count(format('select 1 from deals where id = %L', :'d2_id')),
  1::bigint,
  'и вторая сторона из другого агентства видит ту же сделку');

-- И контакт клиента в ней тоже: иначе с кем вести сделку. Это единственное
-- место, где граница агентства для контакта НЕ ставится, и поставлено оно
-- сознательно.
select test.ok(
  app.can_see_contact(:'rr_contact_id'),
  'контакт чужого клиента в общей сделке виден второй стороне');

-- ===========================================================================
-- 33в. Объект общий, деньги — нет
-- ===========================================================================

set request.jwt.claims = :'claims_rival';
select test.ok(
  test.visible_count(format('select 1 from objects where id = %L', :'obj1')) = 1,
  'чужой опубликованный объект виден: это и есть мультилистинг');

select * from app.listing_terms(:'obj1') \gset lt_
select test.eq(:'lt_mandate_kind'::text, 'exclusive',
  'и тип его договора назван');
select test.eq(:'lt_contract_confirmed'::text, 't',
  'и видно, подписан ли он');
select test.eq(:'lt_agency_name'::text, 'Liberterra'::text,
  'и чьё агентство его ведёт');
select test.eq(:'lt_mine'::text, 'f', 'и что он не мой');

-- А вот денег чужого агентства не видно ни через таблицу, ни через неё же
-- в представлении: стартовая цена и доля агента покупателя — чужая тайна.
select test.eq(
  test.visible_count(format('select 1 from mandates where object_id = %L', :'obj1')),
  0::bigint,
  'стартовой цены и доли по чужому договору не видно');

select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'listing_terms_v'
      and column_name in ('start_price', 'closing_share_ratio', 'commission_rule')),
  0,
  'и в условиях листинга таких столбцов нет вовсе');

select test.ok(:'lt_has_mandate'::boolean, 'и что договор у объекта есть');

-- Функция обходит политики по необходимости, поэтому проверяется её ИСХОДНИК:
-- денежных полей в нём не должно быть ни одного. Иначе однажды «удобно»
-- добавят ещё один столбец, и чужая цена уедет наружу.
select test.eq(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'listing_terms'
      and (p.prosrc like '%start_price%'
        or p.prosrc like '%closing_share%'
        or p.prosrc like '%commission%')),
  0,
  'и в её исходнике нет ни одного денежного поля');

-- ===========================================================================
-- 33г. Инвариант 4 не ослаблен
-- ===========================================================================
-- Самая дорогая ошибка этой миграции, пойманная полным прогоном: первая
-- версия написала в app.can_see_contact() «агент моего агентства» вместо
-- «агент», и контакт стал виден коллегам по компании. Инвариант 4 защищает
-- агента в первую очередь от коллеги, а не от конкурента.

-- Клиент заводится заново и ни в какой сделке не участвует: иначе проверку
-- прошла бы не граница агентства, а оговорка про активную сделку.
set request.jwt.claims = :'claims_bakyt';
select * from create_requirement('rent'::deal_type, null, 'Клиент Бакыта',
         '0555 900 002', 300, 600, '{Юг}', '{1}'::smallint[]) \gset bk_

set request.jwt.claims = :'claims_aibek';
select test.ok(
  not app.can_see_contact(:'bk_contact_id'),
  'коллега по агентству чужого клиента НЕ видит');
select test.ok(
  app.can_see_contact(:'rr_contact_id'),
  'а клиента из общей сделки видит — но именно из-за сделки, а не агентства');
select test.ok(
  app.can_see_contact(:'contact_owner'),
  'а своего — видит');

-- ===========================================================================
-- 33д. Ждущий одобрения не получает агентства
-- ===========================================================================

set request.jwt.claims = :'claims_pending';
select test.ok(
  app.current_agency_id() is null,
  'у ждущего одобрения агентства нет');
select test.eq(
  test.visible_count('select 1 from mandates'), 0::bigint,
  'и договоров он не видит');
select test.eq(
  test.visible_count('select 1 from requirements'), 0::bigint,
  'и клиентов тоже');

-- ===========================================================================
-- 33е. Имя чужого агента видно, его контакты — нет
-- ===========================================================================

set request.jwt.claims = :'claims_rival';
select test.eq(
  test.visible_count(format('select 1 from agents where id = %L', :'agent_aibek')),
  0::bigint,
  'строка чужого агента с почтой и телефоном не видна');
select test.eq(
  (select full_name from platform_agents_v where id = :'agent_aibek'),
  'Айбек',
  'а имя и агентство — видны: иначе непонятно, с кем работаешь');
select test.eq(
  (select count(*)::int from information_schema.columns
    where table_name = 'platform_agents_v'
      and column_name in ('email', 'phone', 'telegram_id', 'auth_user_id')),
  0,
  'почты, телефона и телеграма чужого агента в этом списке нет');

-- ===========================================================================
-- 33ж. Каталогу агентства недоступны
-- ===========================================================================

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.ok(
  not has_table_privilege('anon', 'listing_terms_v', 'select'),
  'анониму условия листинга не выданы');
select test.ok(
  not has_table_privilege('anon', 'platform_agents_v', 'select'),
  'и список агентов платформы тоже');
