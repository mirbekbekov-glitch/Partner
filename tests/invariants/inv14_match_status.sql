-- Статусы подбора (миграция 0017).
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
select test.eq(:'m_status'::text, 'proposed', 'новый подбор предложен');

-- ===========================================================================
-- Цепочка статусов
-- ===========================================================================

select test.eq((set_match_status(:'m_id', 'interested'::match_status)).status,
  'interested'::match_status, 'подбор переведён в «интересно»');

-- Показ без даты — не показ.
select test.throws(
  format($$select set_match_status(%L, 'showing_scheduled')$$, :'m_id'),
  'укажите дату и время показа',
  'назначить показ без даты нельзя');

select * from set_match_status(:'m_id', 'showing_scheduled'::match_status,
  null, now() + interval '2 days') \gset s_
select test.eq(:'s_status'::text, 'showing_scheduled', 'показ назначен с датой');
select test.ok((select showing_at is not null from matches where id = :'m_id'),
  'дата показа записана');

select test.eq((set_match_status(:'m_id', 'showing_done'::match_status)).status,
  'showing_done'::match_status, 'показ отмечен состоявшимся: дата уже есть');

select test.eq((set_match_status(:'m_id', 'bargaining'::match_status)).status,
  'bargaining'::match_status, 'подбор переведён в торг');

-- ===========================================================================
-- Отказ требует причины
-- ===========================================================================

select test.throws(
  format($$select set_match_status(%L, 'rejected')$$, :'m_id'),
  'укажите причину отказа',
  'отказ без причины отклонён');
select test.throws(
  format($$select set_match_status(%L, 'rejected', '   ')$$, :'m_id'),
  'укажите причину отказа',
  'пробелы за причину не считаются');

select * from set_match_status(:'m_id', 'rejected'::match_status,
  'не устроил вид из окна'::text) \gset rj_
select test.eq(:'rj_rejection_reason'::text, 'не устроил вид из окна',
  'причина отказа записана');

-- Вернуться из отказа можно, и причина при этом убирается: она относилась
-- к прошлому решению.
select * from set_match_status(:'m_id', 'interested'::match_status) \gset bk_
select test.ok((select rejection_reason is null from matches where id = :'m_id'),
  'при выходе из отказа причина очищена');

-- ===========================================================================
-- «В сделке» вручную не ставится (инвариант 2)
-- ===========================================================================

select test.throws(
  format($$select set_match_status(%L, 'in_deal')$$, :'m_id'),
  'INVARIANT_2',
  'статус «в сделке» через функцию вручную не ставится');

-- И прямым запросом тоже: PostgREST отдаёт таблицу напрямую, поэтому держит
-- триггер, а не функция. До 0017 это проходило при нуле сделок.
select test.throws(
  format($$update matches set status = 'in_deal' where id = %L$$, :'m_id'),
  'INVARIANT_2',
  'прямой UPDATE в «в сделке» без сделки отбит триггером');

select test.eq((select count(*)::int from deals where match_id = :'m_id'), 0,
  'сделок по подбору действительно нет');

-- А через создание сделки — ставится.
select * from create_deal_from_match(:'m_id') \gset d_
select test.eq((select status from matches where id = :'m_id'), 'in_deal'::match_status,
  'создание сделки перевело подбор в «в сделке»');

-- ===========================================================================
-- Пока сделка жива, подбор из «в сделке» не уводят
-- ===========================================================================
-- Иначе сделка висела бы на подборе, который её отрицает.

select test.throws(
  format($$select set_match_status(%L, 'bargaining')$$, :'m_id'),
  'идёт сделка',
  'подбор с живой сделкой в другой статус не переводится');
select test.throws(
  format($$update matches set status = 'bargaining' where id = %L$$, :'m_id'),
  'идёт сделка',
  'и прямым UPDATE тоже');

-- После срыва сделки подбор снова ведётся.
select fail_deal(:'d_id', 'клиент не вышел на аванс'::text);
select test.eq((set_match_status(:'m_id', 'rejected'::match_status,
                                 'сорвалась сделка'::text)).status,
  'rejected'::match_status, 'после срыва сделки подбор снова ведётся');
reset role;

-- ===========================================================================
-- Кто может вести подбор
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

-- Чынгыз — автор подбора по чужому клиенту: вести его он может.
select * from create_match(:'obj3', :'req2') \gset cm_
select test.ok((select can_lead_match(:'cm_id')),
  'автор подбора может его вести, даже если клиент не его');
select test.eq((set_match_status(:'cm_id', 'interested'::match_status)).status,
  'interested'::match_status, 'автор подбора двигает его по статусам');

-- А чужой подбор, к которому он никак не относится, — нет.
select test.ok(not can_lead_match(:'m_id'),
  'к подбору, где он ни автор, ни агент клиента, прав нет');
select test.throws(
  format($$select set_match_status(%L, 'interested')$$, :'m_id'),
  'FORBIDDEN',
  'чужой подбор вести нельзя');
reset role;

-- Агент клиента ведёт подбор, созданный другим.
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq((set_match_status(:'cm_id', 'bargaining'::match_status)).status,
  'bargaining'::match_status, 'агент клиента ведёт подбор, созданный другим агентом');

-- ===========================================================================
-- Право видно в представлениях кабинета
-- ===========================================================================
select test.ok((select can_lead from object_matches_v where match_id = :'cm_id'),
  'представление объекта сообщает право вести подбор');
select test.ok((select can_lead from requirement_matches_v where match_id = :'cm_id'),
  'представление потребности тоже');
reset role;

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.ok((select not can_lead from object_matches_v where match_id = :'cm_id'),
  'тому, кто вести не может, представление это и говорит');
-- Но сам подбор он видит: условия и комиссия открыты.
select test.ok((select commission_total is not null from object_matches_v
                 where match_id = :'cm_id'),
  'при этом комиссия по подбору ему видна');
reset role;
