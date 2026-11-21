-- ИНВАРИАНТ 32. Объект живёт в работе раньше, чем появляется договор.
--
--   а. Объект заводится без договора — и тогда он не в каталоге, не в
--      подборе и не публикуется. Инвариант 1 не отменяется, он про каталог.
--   б. Ранние этапы работы с собственником — решения агента. Назад не ходят.
--   в. Договор заключается отдельным действием, и заключает его тот, кто
--      ведёт объект. Действующий договор один.
--   г. Колонка воронки выводится из фактов, и «нет подписанного договора»
--      важнее публикации: объект, который рекламируют на честном слове, —
--      это риск, а не реклама.
--   д. «Взят в работу» значит «договор подписан», и отмечает это агент
--      договора.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_aibek';

-- ===========================================================================
-- 32а. Объект без договора
-- ===========================================================================
-- До этой миграции завести такой объект было нельзя вовсе, и первые этапы
-- работы с собственником хранить было негде.

select * from register_object('flat', 'sale', 'Токтогула 101, кв. 7', 72000,
                              null, 'Сыдыков Мурат', '0555 300 101') \gset ro_

select test.eq(:'ro_owner_stage'::text, 'new', 'объект заводится на первом этапе');
select test.eq(:'ro_publication_state'::text, 'draft', 'и не опубликованным');
select test.eq(
  (select count(*) from mandates where object_id = :'ro_id'),
  0::bigint,
  'договора у него нет');

-- Собственник обязателен и здесь: объект, по которому некому звонить, в
-- воронке бесполезен.
-- Проверяется не только отказ, но и ЧТО сказано. Ниже по функции есть
-- вторая проверка — «у нового собственника должно быть имя», — и она ловит
-- тот же вызов, но объясняет неправильно: дело не в имени, а в том, что не
-- указано вообще ничего. Мутационная проверка показала, что без этого
-- утверждения первую проверку можно снять незаметно.
select test.throws(
  $$select register_object('flat', 'sale', 'Безымянная 1', 50000)$$,
  'укажите контакт или имя с телефоном',
  'объект без собственника не завести, и сказано об этом по делу');

-- Инвариант 1 остаётся: он про каталог, а не про работу.
select test.throws(
  format($$select publish_object(%L)$$, :'ro_id'),
  'INVARIANT_1',
  'объект без договора не публикуется');

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.eq(
  (select count(*) from public_catalog_v where id = :'ro_id'),
  0::bigint,
  'и в каталоге его нет');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select count(*) from app.matching_objects(:'req1') where object_id = :'ro_id'),
  0::bigint,
  'и клиенту он не предлагается (инвариант 20)');

-- ===========================================================================
-- 32б. Ранние этапы — решения агента
-- ===========================================================================

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select owner_stage from set_owner_stage(:'ro_id', 'called')),
  'called'::owner_stage,
  'позвонили собственнику');
select test.eq(
  (select stage from listing_funnel_v where object_id = :'ro_id'),
  'called',
  'и колонка воронки это показывает');

select stage_since as t0 from listing_funnel_v where object_id = :'ro_id' \gset
select test.eq(
  (select owner_stage from set_owner_stage(:'ro_id', 'visited')),
  'visited'::owner_stage,
  'съездили на осмотр');
select test.ok(
  (select stage_since from listing_funnel_v where object_id = :'ro_id') > :'t0'::timestamptz,
  'дата входа в колонку сдвинулась');

-- Назад не ходят: «позвонили» не перестаёт быть правдой оттого, что
-- передумали. То же правило, что в инварианте 30.
select test.throws(
  format($$select set_owner_stage(%L, 'called')$$, :'ro_id'),
  'INVARIANT_32',
  'назад по работе с собственником не ходят');
select test.throws(
  format($$update objects set owner_stage = 'new' where id = %L$$, :'ro_id'),
  'INVARIANT_32',
  'и прямой правкой тоже');

-- ===========================================================================
-- 32в. Договор заключается отдельно
-- ===========================================================================
-- Этого не было вовсе: мандат рождался только внутри create_object(), и
-- подписать договор по заведённому вчера объекту было нечем.

select * from sign_mandate(:'ro_id', 'non_exclusive') \gset sm_
select test.eq(:'sm_contract_confirmed'::text, 'f',
  'договор заключён, но ещё не подписан: работа на честном слове');
select test.eq(:'sm_listing_agent_id'::text, :'agent_aibek'::text,
  'ведёт его тот, кто заключил');
select test.eq(:'sm_start_price'::text, '72000.00',
  'стартовая цена взята у объекта: это один разговор с собственником');

-- Действующий договор у объекта один.
select test.throws(
  format($$select sign_mandate(%L, 'exclusive')$$, :'ro_id'),
  'mandates_one_active_per_object_idx',
  'второй действующий договор по объекту не заключить');

-- Объект без собственника в базе возможен (прямой вставкой, переносом), и
-- договор по нему заключать не с кем.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000f6001', 'flat', 'sale', 'Ничья 1', 40000,
        :'agent_aibek');
set role authenticated;
set request.jwt.claims = :'claims_aibek';
select test.throws(
  $$select sign_mandate('00000000-0000-0000-0000-0000000f6001', 'exclusive')$$,
  'договор заключать не с кем',
  'по объекту без собственника договор не заключить');

-- Договор заключает тот, кто ведёт объект.
set request.jwt.claims = :'claims_chyngyz';
select * from register_object('flat', 'sale', 'Чужая 9, кв. 1', 50000,
                              null, 'Чужой Собственник', '0555 300 102') \gset ch_
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$select sign_mandate(%L, 'exclusive')$$, :'ch_id'),
  'INVARIANT_32',
  'чужой объект договором не перехватить');

-- ===========================================================================
-- 32г. «Без договора» важнее публикации
-- ===========================================================================
-- Первая версия ставила проверку публикации выше, и объект, который
-- рекламируют на честном слове, показывался в колонке «В рекламе». Риск,
-- ради которого эта воронка существует, из неё исчезал.

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select stage from listing_funnel_v where object_id = :'ro_id'),
  'no_contract',
  'без подписи колонка — «без договора»');

select test.eq(
  (select publication_state from publish_object(:'ro_id')),
  'published'::publication_state,
  'объект опубликован');

select test.eq(
  (select stage from listing_funnel_v where object_id = :'ro_id'),
  'no_contract',
  'и ВСЁ РАВНО «без договора»: реклама не прячет отсутствие подписи');

-- Тип договора и подпись видны всем агентам, а не только своему. Это и есть
-- ответ на вопрос «получу ли я комиссию, если приведу покупателя».
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  (select mandate_kind from listing_funnel_v where object_id = :'ro_id'),
  'non_exclusive'::mandate_kind,
  'коллега видит тип договора по чужому объекту');
select test.ok(
  (select not contract_confirmed from listing_funnel_v where object_id = :'ro_id'),
  'и видит, что он не подписан');

-- ===========================================================================
-- 32д. «Взят в работу» — это подписанный договор
-- ===========================================================================

select test.throws(
  format($$select confirm_mandate(%L)$$, :'ro_id'),
  'INVARIANT_32',
  'чужой договор подтвердить нельзя');

set request.jwt.claims = :'claims_aibek';
select test.eq(
  (select contract_confirmed from confirm_mandate(:'ro_id')),
  true,
  'агент договора подтвердил подпись');
select test.eq(
  (select stage from listing_funnel_v where object_id = :'ro_id'),
  'advertised',
  'и объект наконец стал рекламой, а не риском');

-- Договор есть, а объявления нет — тоже состояние, и у него свой срок.
select * from register_object('flat', 'sale', 'Киевская 9, кв. 2', 61000,
                              null, 'Орозов Бакай', '0555 300 103') \gset r2_
select sign_mandate(:'r2_id', 'exclusive', null, null, true) is not null as m2 \gset
select test.eq(
  (select stage from listing_funnel_v where object_id = :'r2_id'),
  'contracted',
  'договор подписан, объявления нет');
select test.ok(
  (select stage_limit_days from listing_funnel_v where object_id = :'r2_id') is not null,
  'и у этого простоя есть срок');

-- ===========================================================================
-- 32е. Вставшие карточки видны
-- ===========================================================================

set role postgres;
set request.jwt.claims = '{}';
update objects set owner_stage_since = now() - interval '30 days' where id = :'ch_id';
set role authenticated;
set request.jwt.claims = :'claims_aibek';

select test.ok(
  (select stuck from listing_funnel_v where object_id = :'ch_id'),
  'простоявший объект помечен как вставший');

-- Своего поля «колонка» у объекта нет: расходиться с работой нечему.
select test.eq(
  (select count(*) from information_schema.columns
    where table_name = 'objects'
      and column_name in ('funnel_stage', 'listing_stage', 'stage', 'kanban_column')),
  0::bigint,
  'колонка воронки объекта выводится, а не хранится');

-- ===========================================================================
-- 32ж. Каталогу воронка объектов недоступна
-- ===========================================================================

-- Проверяется ПРАВО, а не текст ошибки. С выданным грантом аноним всё равно
-- упирался бы в политику на objects и получал то же «permission denied» —
-- и тест ничего бы не заметил. Мутационная проверка это показала.
select test.ok(
  not has_table_privilege('anon', 'listing_funnel_v', 'select'),
  'анониму воронка объектов не выдана');

set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.throws(
  'select count(*) from listing_funnel_v',
  'permission denied',
  'и прочитать он её не может');
