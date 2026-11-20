-- ИНВАРИАНТ 21. Сделку ведут её участники; закрытая и сорванная сделки
--               окончательны.
--
-- Тест написан по следам настоящей последовательности, которая проходила
-- целиком. Посторонний агент выполнил подряд:
--
--     close_deal(d, 100000);      -- закрыл чужую сделку
--     close_deal(d, 999999);      -- переписал цену закрытой
--     fail_deal(d, 'передумал');  -- и сорвал её
--
-- Получилась сделка, которой не бывает: status = 'failed' при заполненном
-- closed_at и final_price = 999999 при комиссии, посчитанной от 100000.
-- Мандат при этом остался closed_by_deal, объект снят, потребность закрыта.
\i tests/actors.sql
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claims = :'claims_bakyt';

select id as m from create_match(:'obj1', :'req1') \gset
select id as d from create_deal_from_match(:'m') \gset

select test.eq(
  (select listing_agent_id from deals where id = :'d'), :'agent_aibek'::uuid,
  'листинг-агент сделки взят из мандата');
select test.eq(
  (select closing_agent_id from deals where id = :'d'), :'agent_bakyt'::uuid,
  'агент покупателя взят из потребности');

-- ---- 21а. Посторонний агент сделку не трогает ------------------------------
-- Доля каждого считается по этим полям (инвариант 3), поэтому посторонний в
-- сделке — это не беспорядок в данных, это чужие деньги.
set request.jwt.claims = :'claims_chyngyz';

select test.throws(
  format($$select close_deal(%L, 100000)$$, :'d'),
  'INVARIANT_21: сделку ведут её участники',
  'посторонний агент чужую сделку не закроет');
select test.throws(
  format($$select fail_deal(%L, 'передумал')$$, :'d'),
  'INVARIANT_21: сделку ведут её участники',
  'и не сорвёт');
-- Прямую правку останавливает построчная политика — МОЛЧА, ноль изменённых
-- строк и никакой ошибки. Поэтому проверяется следствие, а не текст отказа:
-- «упало» и «не подействовало» — разные вещи, и вторую легко принять за
-- первую. Триггер здесь второй слой, он сработает там, где политика пустит.
update deals set final_price = 1 where id = :'d';
select test.eq(
  (select final_price from deals where id = :'d'), null::numeric,
  'прямая правка постороннего агента не подействовала');

-- Заводить сделку по чужому подбору тоже нельзя.
select test.throws(
  format($$select create_deal_from_match(%L)$$, :'m'),
  'INVARIANT_21: сделку заводит её участник',
  'посторонний агент сделку по чужому подбору не заведёт');

-- ---- 21б. Участник закрывает, суммы фиксируются ----------------------------
set request.jwt.claims = :'claims_aibek';
select commission_total as fixed_total, closing_share as fixed_closing
  from close_deal(:'d', 100000) \gset

select test.eq(:'fixed_total'::numeric, 2000::numeric,
  'комиссия посчитана от финальной цены: 2% от 100 000');
select test.eq(
  (select final_price from deals where id = :'d'), 100000::numeric,
  'финальная цена записана');
select test.ok(
  (select closed_at is not null from deals where id = :'d'),
  'дата закрытия проставлена');

-- Комиссия попадает в строку одной записью, а не вторым UPDATE по уже
-- закрытой сделке: иначе «закрытая неизменна» требовала бы исключения для
-- самой системы, а исключение в правиле про деньги стоит дороже переделки.
select test.eq(
  (select count(*)::int from audit_log
    where entity_type = 'deal' and entity_id = :'d' and action = 'update'),
  1, 'закрытие сделки — одна запись в журнале, а не две');

-- ---- 21в. Закрытая сделка окончательна -------------------------------------
select test.throws(
  format($$select close_deal(%L, 999999)$$, :'d'),
  'INVARIANT_21: сделка уже закрыта, сумма зафиксирована',
  'второй раз сделку не закрыть');

select test.throws(
  format($$select fail_deal(%L, 'передумал')$$, :'d'),
  'INVARIANT_21: сделка закрыта, сорвать её нельзя',
  'закрытую сделку не сорвать');

select test.throws(
  format($$update deals set final_price = 999999 where id = %L$$, :'d'),
  'INVARIANT_21: цена и комиссия закрытой сделки неизменны',
  'цену закрытой сделки не переписать');

select test.throws(
  format($$update deals set commission_total = 1 where id = %L$$, :'d'),
  'INVARIANT_21: цена и комиссия закрытой сделки неизменны',
  'комиссию закрытой сделки не переписать');

select test.throws(
  format($$update deals set status = 'deposit' where id = %L$$, :'d'),
  'INVARIANT_21: закрытая сделка не меняет состояние',
  'закрытую сделку не вернуть в работу');

-- Цена и комиссия после всех попыток те же, что были.
select test.eq(
  (select final_price from deals where id = :'d'), 100000::numeric,
  'цена осталась прежней');
select test.eq(
  (select commission_total from deals where id = :'d'), 2000::numeric,
  'и комиссия соответствует этой цене');

-- ---- 21г. Сорванная сделка окончательна ------------------------------------
set request.jwt.claims = :'claims_bakyt';
select id as m2 from create_match(:'obj3', :'req2') \gset
select id as d2 from create_deal_from_match(:'m2') \gset
select test.eq((select status from fail_deal(:'d2', 'клиент передумал')),
  'failed'::deal_status, 'сделка сорвана');

select test.throws(
  format($$select close_deal(%L, 50000)$$, :'d2'),
  'INVARIANT_21: сделка сорвана, закрыть её нельзя',
  'сорванную сделку не закрыть задним числом');
select test.throws(
  format($$update deals set status = 'closed' where id = %L$$, :'d2'),
  'INVARIANT_21: сорванную сделку не закрыть задним числом',
  'и прямой правкой тоже');

-- ---- 21д. Срыв возвращает клиента и подбор в работу ------------------------
-- Иначе подбор навсегда остаётся «в сделке», которой нет, и предложить этот
-- объект клиенту снова нечем.
select test.eq(
  (select status from requirements where id = :'req2'),
  'qualified'::requirement_status, 'потребность вернулась в работу');
select test.eq(
  (select status from matches where id = :'m2'),
  'interested'::match_status, 'подбор вернулся в работу');

-- ---- 21е. Закрытие закрывает мандат и потребность --------------------------
select test.eq(
  (select status from mandates where id = (select mandate_id from deals where id = :'d')),
  'closed_by_deal'::mandate_status, 'мандат закрыт сделкой');
select test.eq(
  (select status from requirements where id = :'req1'),
  'closed'::requirement_status, 'потребность закрыта сделкой');

-- ---- 21ж. Администратор может всё, но это видно ----------------------------
-- Админ нужен для исправлений, и каждое его действие остаётся в журнале
-- инварианта 7.
set request.jwt.claims = :'claims_admin';
select test.throws(
  format($$update deals set final_price = 123 where id = %L$$, :'d'),
  'INVARIANT_21: цена и комиссия закрытой сделки неизменны',
  'даже администратор не переписывает закрытую сделку');

-- ---- 21з. Каталогу сделки недоступны ---------------------------------------
set role postgres; set role anon;
select test.throws(
  $$select * from agent_deals_v$$,
  'permission denied for view agent_deals_v',
  'аноним не видит сделок');
select test.throws(
  format($$select close_deal(%L, 1)$$, :'d'),
  'permission denied for function close_deal',
  'аноним не закрывает сделок');
