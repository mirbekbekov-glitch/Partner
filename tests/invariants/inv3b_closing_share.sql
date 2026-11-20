-- ИНВАРИАНТ 3, вторая редакция. Ставку вознаграждения назначает владелец мандата.
--   50/50 остаётся значением по умолчанию;
--   назначить ставку может только listing-агент мандата;
--   после закрытой сделки ставка неизменна.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- ---- 3б-а. По умолчанию делёж пополам -------------------------------------
select test.ok(
  (select closing_share_ratio from mandates where id = :'mandate1') is null,
  'в мандате ставка не задана');

select * from create_match(:'obj1', :'req1') \gset m1_
select test.eq(
  (select closing_share_ratio from match_commission_v where match_id = :'m1_id'),
  0.50::numeric, 'без ставки подбор считает 50/50');

select test.eq(
  (select listing_share from match_commission_v where match_id = :'m1_id'),
  (select closing_share from match_commission_v where match_id = :'m1_id'),
  'без ставки доли равны');

-- ---- 3б-б. Ставку назначает только владелец мандата ------------------------
-- Мандат на obj1 принадлежит Айбеку. Бакыт ведёт клиента, но не мандат.
select test.throws(
  format($$select set_closing_share(%L, 0.30)$$, :'mandate1'),
  'INVARIANT_3',
  'чужой агент ставку назначить не может');

set request.jwt.claims = :'claims_aibek';
select * from set_closing_share(:'mandate1', 0.30) \gset mr_
select test.eq(:'mr_closing_share_ratio'::numeric, 0.3000::numeric,
  'владелец мандата назначил ставку 30%');

-- ---- 3б-в. Ставка вне диапазона отклонена ---------------------------------
select test.throws(
  format($$select set_closing_share(%L, 1.4)$$, :'mandate1'),
  'INVARIANT_3',
  'ставка больше единицы отклонена');

select test.throws(
  format($$update mandates set closing_share_ratio = -0.1 where id = %L$$, :'mandate1'),
  'check constraint',
  'отрицательная ставка отклонена и прямым UPDATE');

-- ---- 3б-г. Подбор и сделка считают по ставке ------------------------------
select test.eq(
  (select closing_share_ratio from match_commission_v where match_id = :'m1_id'),
  0.3000::numeric, 'подбор видит ставку мандата');

-- База: продажа 2% от 85000 = 1700. Агент покупателя получает 30% = 510.
select test.eq(
  (select commission_total from match_commission_v where match_id = :'m1_id'),
  1700.00::numeric, 'итог комиссии считается от цены объекта');
select test.eq(
  (select closing_share from match_commission_v where match_id = :'m1_id'),
  510.00::numeric, 'доля агента покупателя 30% от итога');
select test.eq(
  (select listing_share from match_commission_v where match_id = :'m1_id'),
  1190.00::numeric, 'остаток достался владельцу мандата');

-- ---- 3б-д. Закрытие фиксирует доли по ставке -------------------------------
set request.jwt.claims = :'claims_bakyt';
select * from create_deal_from_match(:'m1_id') \gset d1_
select * from close_deal(:'d1_id', 90000) \gset closed_

-- 2% от финальных 90000 = 1800; 30% из них = 540.
select test.eq(:'closed_commission_total'::numeric, 1800.00::numeric,
  'итог пересчитан от финальной цены');
select test.eq(:'closed_closing_share'::numeric, 540.00::numeric,
  'доля агента покупателя зафиксирована по ставке');
select test.eq(:'closed_listing_share'::numeric, 1260.00::numeric,
  'доля владельца мандата зафиксирована');
select test.eq(
  (:'closed_listing_share'::numeric + :'closed_closing_share'::numeric),
  :'closed_commission_total'::numeric,
  'две доли складываются ровно в итог');

-- ---- 3б-е. После закрытой сделки ставка неизменна --------------------------
set request.jwt.claims = :'claims_aibek';
select test.throws(
  format($$select set_closing_share(%L, 0.50)$$, :'mandate1'),
  'INVARIANT_3',
  'ставку нельзя переписать после закрытой сделки');

select test.throws(
  format($$update mandates set closing_share_ratio = 0.9 where id = %L$$, :'mandate1'),
  'INVARIANT_3',
  'прямой UPDATE ставки после закрытой сделки тоже отклонён');

select test.eq(
  (select closing_share_ratio from mandates where id = :'mandate1'),
  0.3000::numeric, 'ставка в мандате осталась прежней');

-- ---- 3б-ж. Ставка 0 законна: вознаграждения нет ---------------------------
select * from set_closing_share(:'mandate3', 0) \gset zero_
select test.eq(:'zero_closing_share_ratio'::numeric, 0.0000::numeric,
  'ставка 0 принята: партнёрского вознаграждения нет');

set request.jwt.claims = :'claims_bakyt';
select * from create_match(:'obj3', :'req2') \gset m3_
select test.eq(
  (select closing_share from match_commission_v where match_id = :'m3_id'),
  0.00::numeric, 'при ставке 0 агенту покупателя не достаётся ничего');
select test.eq(
  (select listing_share from match_commission_v where match_id = :'m3_id'),
  (select commission_total from match_commission_v where match_id = :'m3_id'),
  'весь итог у владельца мандата');
