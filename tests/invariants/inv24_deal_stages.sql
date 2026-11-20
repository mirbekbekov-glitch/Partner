-- ИНВАРИАНТ 24. Срыв сделки возвращает клиента и подбор в работу, как бы он
--               ни был сделан; этап сделки датирован, и застрявшая сделка
--               видна.
--
-- Этапы в схеме были с первого дня, а пользоваться ими было нечем: кабинет
-- показывал «задаток» до самого закрытия. Два вопроса, на которые агентство
-- не могло ответить: на каком этапе сделка и сколько она там стоит.
--
-- По дороге нашлась дыра. fail_deal() возвращает потребность и подбор в
-- работу, а прямая правка — нет:
--
--     update deals set status = 'failed', failure_reason = 'мимо функции';
--
-- Сделка сорвана, а потребность и подбор остаются in_deal навсегда: новую
-- сделку по клиенту не завести, предложить ему объект снова нельзя. Клиент
-- заперт.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select id as m1 from create_match(:'obj1', :'req1') \gset
select id as d1 from create_deal_from_match(:'m1') \gset

-- ---- 24а. Срыв прямой правкой возвращает клиента в работу -----------------
-- Главное правило: последствия срыва одинаковы при любом пути, потому что
-- живут в триггере, а не в функции.
update deals set status = 'failed', failure_reason = 'мимо функции' where id = :'d1';

select test.eq(
  (select status from requirements where id = :'req1'),
  'qualified'::requirement_status,
  'клиент вернулся в работу даже при срыве мимо функции');
select test.eq(
  (select status from matches where id = :'m1'),
  'interested'::match_status,
  'и подбор тоже: иначе предложить объект снова будет нечем');

-- Проверяется именно это: клиент не заперт, по нему можно работать дальше.
select id as m2 from create_match(:'obj2', :'req1') \gset
select test.ok(:'m2' is not null, 'по вернувшемуся клиенту снова заводится подбор');

-- ---- 24б. Этап датирован ---------------------------------------------------
select id as d2 from create_deal_from_match(:'m2') \gset

select test.eq(
  (select status from deals where id = :'d2'), 'deposit'::deal_status,
  'сделка начинается с задатка');
select test.ok(
  (select stage_since from deals where id = :'d2') is not null,
  'дата входа в этап проставлена сразу');

select stage_since as first_stage from deals where id = :'d2' \gset

select test.eq(
  (select status from set_deal_stage(:'d2', 'documents')),
  'documents'::deal_status, 'этап сменился');
select test.ok(
  (select stage_since from deals where id = :'d2') > :'first_stage'::timestamptz,
  'и дата входа в этап обновилась');

-- Правка, не меняющая этапа, дату не трогает: иначе «сколько стоит на
-- этапе» считалось бы от последнего касания, а не от входа.
select stage_since as doc_stage from deals where id = :'d2' \gset
update deals set failure_reason = null where id = :'d2';
select test.eq(
  (select stage_since from deals where id = :'d2'), :'doc_stage'::timestamptz,
  'правка без смены этапа дату не двигает');

-- ---- 24в. Назад тоже можно -------------------------------------------------
-- На подписании выясняется, что нужен ещё документ. Запрет на возврат
-- заставил бы агента врать системе о том, где он стоит, а неправдивый этап
-- хуже отсутствующего.
select test.eq(
  (select status from set_deal_stage(:'d2', 'signing')),
  'signing'::deal_status, 'сделка дошла до подписания');
select test.eq(
  (select status from set_deal_stage(:'d2', 'documents')),
  'documents'::deal_status, 'и вернулась к документам');

-- ---- 24г. Закрытие и срыв — не этапы ---------------------------------------
-- У них есть обязательные спутники: финальная цена и причина.
select test.throws(
  format($$select set_deal_stage(%L, 'closed')$$, :'d2'),
  'INVARIANT_24: закрытие и срыв — отдельные действия',
  'закрыть сделку сменой этапа нельзя');
select test.throws(
  format($$select set_deal_stage(%L, 'failed')$$, :'d2'),
  'INVARIANT_24: закрытие и срыв — отдельные действия',
  'сорвать сделку сменой этапа тоже нельзя');

select test.throws(
  format($$select set_deal_stage(%L, 'documents')$$, :'d2'),
  'INVARIANT_24: сделка уже на этапе «documents»',
  'переставить сделку на тот же этап незачем');

-- ---- 24д. Завершённой сделке этап не поменять ------------------------------
select commission_total from close_deal(:'d2', 90000) \gset
select test.throws(
  format($$select set_deal_stage(%L, 'documents')$$, :'d2'),
  'INVARIANT_24: сделка уже завершена, этап ей не поменять',
  'закрытой сделке этап не поменять');

-- ---- 24е. Застрявшая сделка видна ------------------------------------------
-- Та же мысль, что в отчёте о подвисших объектах: молчание не значит
-- благополучие.
set role postgres;
set request.jwt.claims = '{}';
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-00000000fb01', 'flat', 'sale',
        'Застрявшая сделка', 70000, :'agent_bakyt');
insert into mandates (object_id, kind, start_price, listing_agent_id,
                      contract_confirmed, status)
values ('00000000-0000-0000-0000-00000000fb01', 'non_exclusive', 70000,
        :'agent_bakyt', true, 'active');

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select id as req3 from create_requirement(
  'sale', p_client_name => 'Клиент застрявшей сделки',
  p_client_phone => '0700 81 81 81', p_budget_max => 100000) \gset
select id as m3 from create_match('00000000-0000-0000-0000-00000000fb01', :'req3') \gset
select id as d3 from create_deal_from_match(:'m3') \gset

select test.eq(
  (select count(*)::int from stuck_deals_v where deal_id = :'d3'),
  0, 'свежая сделка в отчёт не попадает');

-- Задаток внесён — дальше должно двигаться быстро, иначе передумают.
set role postgres;
set request.jwt.claims = '{}';
update deals set stage_since = now() - interval '10 days' where id = :'d3';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select days_in_stage from stuck_deals_v where deal_id = :'d3'),
  10, 'сделка, стоящая на задатке 10 дней, в отчёте');
select test.eq(
  (select stage_budget_days from stuck_deals_v where deal_id = :'d3'),
  7, 'и видно, сколько этому этапу отведено');
select test.ok(
  (select mine from stuck_deals_v where deal_id = :'d3'),
  'и что это моя сделка');

-- У сбора документов срок другой: в Бишкеке это дело небыстрое.
select set_deal_stage(:'d3', 'documents');
set role postgres;
set request.jwt.claims = '{}';
update deals set stage_since = now() - interval '10 days' where id = :'d3';

set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select count(*)::int from stuck_deals_v where deal_id = :'d3'),
  0, 'те же 10 дней на сборе документов нормальны');

-- ---- 24ж. Завершённые сделки в отчёт не попадают ---------------------------
-- Держится это на том, что у завершённых этапов нет срока: сравнение с NULL
-- ничего не отбирает. Зависимость неочевидная, поэтому проверяется прямо.
select test.ok(
  app.deal_stage_days('closed') is null and app.deal_stage_days('failed') is null,
  'у завершённых сделок срока этапа нет — на этом держится отбор в отчёт');

set role postgres;
set request.jwt.claims = '{}';
update deals set stage_since = now() - interval '100 days' where id = :'d2';
set role authenticated;
set request.jwt.claims = :'claims_bakyt';
select test.eq(
  (select count(*)::int from stuck_deals_v where deal_id = :'d2'),
  0, 'закрытая сделка не застревает: она завершена');

-- ---- 24з. Посторонний этап не двигает ---------------------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.throws(
  format($$select set_deal_stage(%L, 'signing')$$, :'d3'),
  'INVARIANT_21: сделку ведут её участники',
  'чужой сделке этап не поменять');

-- ---- 24и. Каталогу этапы недоступны -----------------------------------------
set role postgres; set role anon;
select test.throws(
  format($$select set_deal_stage(%L, 'signing')$$, :'d3'),
  'permission denied for function set_deal_stage',
  'аноним этапы не двигает');
select test.throws(
  $$select * from stuck_deals_v$$,
  'permission denied for view stuck_deals_v',
  'аноним отчёт о сделках не видит');
