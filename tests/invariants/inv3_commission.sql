-- ИНВАРИАНТ 3. listing_agent из мандата, closing_agent из подбора, 50/50.
--              База: продажа 2% цены, аренда 50% первого месяца.
--              До закрытия — индикативно от текущей цены, после — от финальной.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- ---- 3а. База расчёта -----------------------------------------------------
select test.eq(app.commission_total('sale', 100000, null), 2000.00::numeric,
  'продажа: 2% цены');
select test.eq(app.commission_total('rent', 500, null), 250.00::numeric,
  'аренда: 50% первого месяца');

-- ---- 3б. Делёж всегда сходится в итог ------------------------------------
select test.ok(
  (select bool_and(s.listing_share + s.closing_share = t.total)
     from (values (2000.00::numeric),(1234.57::numeric),(0.01::numeric),(333.33::numeric)) t(total),
          app.commission_shares(t.total) s),
  'две доли складываются ровно в итог, включая нечётные копейки');

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select * from create_match(:'obj2', :'req1') \gset m_
select * from create_deal_from_match(:'m_id') \gset d_

-- ---- 3в. До закрытия: индикативно, от ТЕКУЩЕЙ цены -----------------------
select test.ok(
  (select is_indicative from deal_commission_v where deal_id = :'d_id'),
  'до закрытия комиссия помечена индикативной');
select test.eq(
  (select commission_total from deal_commission_v where deal_id = :'d_id'),
  2200.00::numeric, 'индикативная комиссия = 2% от текущей цены 110000');

reset role;
-- Клеймы сбрасываются вместе с ролью: «set role postgres» их не трогает, и
-- настройка данных от имени владельца базы шла бы с чужим auth.uid(), то есть
-- притворяясь агентом. Инвариант 22 это заметил.
set request.jwt.claims = '{}';
update objects set price = 120000 where id = :'obj2';
set request.jwt.claims = :'claims_bakyt';
set role authenticated;

select test.eq(
  (select commission_total from deal_commission_v where deal_id = :'d_id'),
  2400.00::numeric, 'правка цены двигает индикативную комиссию (120000 → 2400)');

-- Суммы в самой сделке до закрытия не записаны: индикатив ничего не фиксирует.
select test.ok(
  (select commission_total is null from deals where id = :'d_id'),
  'до закрытия суммы в сделке не зафиксированы');

-- ---- 3г. После закрытия: от ФИНАЛЬНОЙ цены, зафиксировано ----------------
select * from close_deal(:'d_id', 100000) \gset c_

select test.eq(:'c_commission_total'::numeric, 2000.00::numeric,
  'итоговая комиссия = 2% от финальной цены 100000, не от 120000');
select test.eq(:'c_listing_share'::numeric, 1000.00::numeric, 'доля listing-агента 50%');
select test.eq(:'c_closing_share'::numeric, 1000.00::numeric, 'доля closing-агента 50%');

select test.ok(
  (select is_final from deal_commission_v where deal_id = :'d_id'),
  'после закрытия комиссия помечена финальной');

-- Правка цены объекта после закрытия финальную комиссию не трогает.
reset role;
-- Клеймы сбрасываются вместе с ролью: «set role postgres» их не трогает, и
-- настройка данных от имени владельца базы шла бы с чужим auth.uid(), то есть
-- притворяясь агентом. Инвариант 22 это заметил.
set request.jwt.claims = '{}';
update objects set price = 999000 where id = :'obj2';
select test.eq(
  (select commission_total from deals where id = :'d_id'), 2000.00::numeric,
  'правка цены после закрытия не пересчитывает зафиксированную комиссию');

-- ---- 3д. Правило мандата переопределяет базу -----------------------------
update mandates set commission_rule = '{"kind":"percent","value":3}'::jsonb
 where id = :'mandate3';
select test.eq(
  (select commission_total from match_commission_v
    where object_id = :'obj3' limit 1),
  null::numeric, 'без подбора строки в match_commission_v нет');

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj3', :'req2') \gset m3_
select test.eq(
  (select commission_total from match_commission_v where match_id = :'m3_id'),
  4500.00::numeric, 'commission_rule мандата (3%) переопределяет базовые 2%');

-- ---- 3е. Стороны берутся из мандата и подбора ----------------------------
select test.eq(
  (select listing_agent_id from match_commission_v where match_id = :'m3_id')::text,
  :'agent_aibek'::text, 'listing_agent подбора взят из мандата');
select test.eq(
  (select closing_agent_id from match_commission_v where match_id = :'m3_id')::text,
  :'agent_bakyt'::text, 'closing_agent подбора — агент, ведущий клиента');
