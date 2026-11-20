-- ИНВАРИАНТ 12. Кандидат, взятый в работу, закреплён за одним агентом.
--               Телефон из объявления виден только взявшему.
-- ИНВАРИАНТ 13. Сборщик пишет только в кандидатов и не достаёт ни до объектов,
--               ни до контактов, ни до мандатов.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 13а. Сборщик кладёт объявление в пул --------------------------------
set role collector;
select app.upsert_candidate(jsonb_build_object(
  'source', 'lalafo', 'external_id', 'LF-100500',
  'url', 'https://example.invalid/LF-100500',
  'title', '2-комн., Центр', 'address', 'Киевская 95',
  'zone', 'Центр', 'kind', 'flat', 'deal_type', 'sale',
  'rooms', 2, 'area', 56.5, 'floor', 4, 'floors_total', 9,
  'price', 73000, 'photos_count', 6, 'author', 'owner',
  'phone', '0700 55-44-33',
  'raw', jsonb_build_object('seen', 'тест')
)) as cand \gset

select test.ok(:'cand' is not null, 'сборщик принял объявление');

-- ---- 13б. Больше сборщику недоступно ничего ------------------------------
-- Это не аккуратность кода, а то, до чего роль физически не дотягивается:
-- ошибка в разборе чужой страницы не может стать записью в каталоге.
select test.throws(
  $$select 1 from objects limit 1$$,
  'permission denied for table objects',
  'сборщик не читает объекты');

select test.throws(
  $$select 1 from contacts limit 1$$,
  'permission denied for table contacts',
  'сборщик не читает контакты');

select test.throws(
  $$select 1 from mandates limit 1$$,
  'permission denied for table mandates',
  'сборщик не читает мандаты');

select test.throws(
  $$select 1 from listing_candidates limit 1$$,
  'permission denied for table listing_candidates',
  'сборщик не читает даже сам пул: у него есть только функция приёма');

select test.throws(
  format($$insert into objects (kind, deal_type, address, price, created_by_agent_id)
           values ('flat', 'sale', 'Из парсера', 1, %L)$$, :'agent_aibek'),
  'permission denied for table objects',
  'сборщик не создаёт объекты');

-- ---- 13в. Повторный проход обновляет, а не плодит ------------------------
select app.upsert_candidate(jsonb_build_object(
  'source', 'lalafo', 'external_id', 'LF-100500',
  'title', '2-комн., Центр', 'address', 'Киевская 95',
  'kind', 'flat', 'deal_type', 'sale', 'price', 69000,
  'author', 'owner', 'phone', '+996700554433'
)) as again \gset

select test.eq(:'again'::text, :'cand'::text,
  'повторный проход вернул того же кандидата');

set role postgres;
select test.eq((select count(*)::int from listing_candidates where external_id = 'LF-100500'), 1,
  'второй записи не появилось');
select test.eq((select price from listing_candidates where external_id = 'LF-100500'),
  69000::numeric, 'цена обновилась');
-- История цены берётся из журнала: отдельной таблицы не нужно.
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'candidate' and action = 'update' and diff ? 'price') >= 1,
  'изменение цены попало в журнал');

-- ---- 12а. Свободного кандидата видно всем, кроме телефона ----------------
set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select test.eq(
  test.visible_count($$select 1 from listing_candidates where external_id = 'LF-100500'$$),
  1::bigint, 'свободный кандидат виден агенту');

select test.ok(
  (select phone from candidate_feed_v where external_id = 'LF-100500') is null,
  'телефон свободного кандидата не виден: ради него и берут в работу');

-- ---- 12б. Взятие открывает телефон ---------------------------------------
select id as c1 from listing_candidates where external_id = 'LF-100500' \gset
select * from claim_candidate(:'c1', 3) \gset cl_
select test.eq(:'cl_status'::text, 'in_work', 'кандидат взят в работу');
select test.eq(:'cl_claimed_by_agent_id'::text, :'agent_bakyt'::text, 'взят текущим агентом');

select test.eq(
  (select phone from candidate_feed_v where id = :'c1'), '+996700554433',
  'взявшему агенту телефон виден и нормализован');

-- ---- 12в. Другому агенту кандидат закрыт ---------------------------------
set request.jwt.claims = :'claims_aibek';
select test.ok(
  (select phone from candidate_feed_v where id = :'c1') is null,
  'чужой агент телефона взятого кандидата не видит');

select test.ok(
  (select is_free from candidate_feed_v where id = :'c1') is false,
  'но видит, что кандидат занят, и не звонит следом');

select test.throws(
  format($$select claim_candidate(%L)$$, :'c1'),
  'INVARIANT_12',
  'перехватить взятого кандидата нельзя');

-- Прямой UPDATE чужим агентом не падает с ошибкой: построчная политика
-- просто не отдаёт ему строку, и правка задевает ноль строк. Проверяется
-- поэтому эффект, а не сообщение.
update listing_candidates set claimed_by_agent_id = :'agent_aibek' where id = :'c1';
select test.eq(
  (select claimed_by_agent_id from listing_candidates where id = :'c1')::text,
  :'agent_bakyt'::text,
  'прямой UPDATE чужим агентом владение не изменил');

-- А вот отдать своё взятие другому прямой правкой не может и сам держатель:
-- это уже ловит триггер.
set request.jwt.claims = :'claims_bakyt';
select test.throws(
  format($$update listing_candidates set claimed_by_agent_id = %L where id = %L$$,
         :'agent_chyngyz', :'c1'),
  'INVARIANT_12',
  'передать взятие прямым UPDATE нельзя даже держателю');
set request.jwt.claims = :'claims_aibek';

-- ---- 12г. Превратить в объект может только взявший -----------------------
-- Объект и мандат создаются обычным путём: инвариант 1 никуда не делся.
set request.jwt.claims = :'claims_aibek';
set role postgres;
insert into objects (id, kind, deal_type, address, zone, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fd001', 'flat', 'sale', 'Киевская 95',
        'Центр', 73000, :'agent_aibek');
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000fd001', 'exclusive', 73000, :'agent_aibek', true, 'active');
set role authenticated;

select test.throws(
  format($$select convert_candidate(%L, %L)$$, :'c1', '00000000-0000-0000-0000-0000000fd001'),
  'не взят вами в работу',
  'чужой агент кандидата объектом не закроет');

-- ---- 12д. Без мандата кандидат не закрывается ----------------------------
set request.jwt.claims = :'claims_bakyt';
set role postgres;
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fd002', 'flat', 'sale', 'Без договора', 50000,
        :'agent_bakyt');
set role authenticated;

select test.throws(
  format($$select convert_candidate(%L, %L)$$, :'c1', '00000000-0000-0000-0000-0000000fd002'),
  'INVARIANT_12',
  'без действующего мандата кандидат объектом не закрывается');

-- ---- 12е. Нормальный путь ------------------------------------------------
set role postgres;
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000fd002', 'non_exclusive', 50000, :'agent_bakyt', true, 'active');
set role authenticated;

select * from convert_candidate(:'c1', '00000000-0000-0000-0000-0000000fd002') \gset conv_
select test.eq(:'conv_status'::text, 'taken', 'кандидат закрыт объектом');
select test.eq(:'conv_object_id'::text, '00000000-0000-0000-0000-0000000fd002',
  'ссылка на объект проставлена');

-- ---- 12ж. Один кандидат — один объект ------------------------------------
set role collector;
select app.upsert_candidate(jsonb_build_object(
  'source', 'house_kg', 'external_id', 'HK-77', 'title', 'та же квартира',
  'kind', 'flat', 'deal_type', 'sale', 'price', 73000, 'author', 'owner'
)) as c2 \gset
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select * from claim_candidate(:'c2') \gset cl2_

select test.throws(
  format($$select convert_candidate(%L, %L)$$, :'c2', '00000000-0000-0000-0000-0000000fd002'),
  'candidates_one_object_idx',
  'второй кандидат на тот же объект отклонён');

-- ---- 12з. Отказ освобождает и требует причины ----------------------------
select test.throws(
  format($$select reject_candidate(%L, '  ')$$, :'c2'),
  'INVARIANT_12',
  'отказ без причины отклонён');

select * from reject_candidate(:'c2', 'это посредник, не собственник') \gset rj_
select test.eq(:'rj_status'::text, 'rejected', 'кандидат отклонён');

-- ---- 12и. Просроченное взятие освобождается ------------------------------
set role collector;
select app.upsert_candidate(jsonb_build_object(
  'source', 'lalafo', 'external_id', 'LF-200', 'title', 'третий',
  'kind', 'flat', 'deal_type', 'rent', 'price', 400, 'author', 'owner',
  'phone', '0555123456'
)) as c3 \gset
set role authenticated;
select * from claim_candidate(:'c3', 1) \gset cl3_

set role postgres;
update listing_candidates set claimed_until = now() - interval '1 hour' where id = :'c3';
set role authenticated;

select test.eq(app.release_stale_claims(), 1, 'просроченное взятие освобождено');
select test.eq(
  (select status from listing_candidates where id = :'c3'), 'new'::candidate_status,
  'кандидат вернулся в общий пул');
select test.ok(
  (select phone from candidate_feed_v where id = :'c3') is null,
  'и телефон снова закрыт');

-- ---- 12к. Исчезнувшее с площадки помечается, а не удаляется --------------
set role collector;
set role postgres;
update listing_candidates set last_seen_at = now() - interval '5 days' where id = :'c3';
set role collector;
select test.eq(
  app.mark_candidates_gone('lalafo'::listing_source, array['LF-100500']::text[]), 1,
  'объявление, которого не было в проходе, помечено исчезнувшим');

set role postgres;
select test.eq(
  (select status from listing_candidates where id = :'c3'), 'gone'::candidate_status,
  'запись осталась, чтобы не брать в работу снятое');

-- ---- 12л. Анониму пул недоступен -----------------------------------------
set role anon;
set request.jwt.claims = '{"role":"anon"}';
select test.throws(
  $$select 1 from listing_candidates limit 1$$,
  'permission denied for table listing_candidates',
  'пул объявлений анониму недоступен');
