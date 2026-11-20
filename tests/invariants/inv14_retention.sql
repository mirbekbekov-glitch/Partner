-- ИНВАРИАНТ 14. Телефон невзятого кандидата не хранится дольше срока,
--               кандидат, ставший объектом, не удаляется никогда,
--               а после очистки номера не остаётся нигде, включая журнал.
\i tests/actors.sql
\set ON_ERROR_STOP on

\set phone_idle   '0700 111-001'
\set phone_live   '0700 111-002'
\set phone_inwork '0700 111-003'
\set phone_taken  '0700 111-004'
\set phone_trace  '0700 111-006'

-- Пул заводится настоящим путём: через функцию приёма, от имени сборщика.
-- Прямые вставки показали бы работу очистки на данных, которых в жизни не
-- бывает, — например с номером в свободном тексте, который приём затирает.
set role collector;

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-OLD-PHONE','title','давно не видели',
  'kind','flat','deal_type','sale','price',60000,'author','owner',
  'phone', :'phone_idle',
  'description', 'Собственник, звоните ' || :'phone_idle',
  'raw', jsonb_build_object('text','в сыром виде тоже есть ' || :'phone_idle'))) as c_idle \gset

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-LIVE','title','видели вчера',
  'kind','flat','deal_type','sale','price',61000,'author','owner',
  'phone', :'phone_live')) as c_live \gset

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-IN-WORK','title','взят в работу',
  'kind','flat','deal_type','sale','price',62000,'author','owner',
  'phone', :'phone_inwork')) as c_work \gset

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-TAKEN','title','стал объектом',
  'kind','flat','deal_type','sale','price',65000,'author','owner',
  'phone', :'phone_taken')) as c_taken \gset

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-OLD-RECORD','title','очень старый',
  'kind','flat','deal_type','sale','price',64000,'author','owner')) as c_old \gset

-- ---- 14а. Номер хранится в одном месте ------------------------------------
-- Без этого срок хранения был бы неправдой: площадка отдаёт номер и отдельным
-- полем, и внутри текста объявления.
set role postgres;

select test.eq(
  (select phone from listing_candidate_phones where candidate_id = :'c_idle'),
  '+996700111001', 'номер сохранён отдельной таблицей и нормализован');

select test.ok(
  (select description from listing_candidates where id = :'c_idle') like '%<номер скрыт>%',
  'номер в описании затёрт при приёме');

select test.eq(
  (select count(*)::int from listing_candidates
    where id = :'c_idle' and (description like '%111-001%' or raw::text like '%111-001%')),
  0, 'номера нет ни в описании, ни в сырых данных');

select test.eq(
  (select count(*)::int from audit_log
    where entity_type = 'candidate' and diff::text like '%111-001%'),
  0, 'номера нет и в журнале приёма');

-- ---- Расставляем сроки и состояния ---------------------------------------
update listing_candidates set last_seen_at = now() - interval '45 days'  where id = :'c_idle';
update listing_candidates set last_seen_at = now() - interval '1 day'    where id = :'c_live';
update listing_candidates set last_seen_at = now() - interval '200 days',
       status = 'in_work', claimed_by_agent_id = :'agent_bakyt',
       claimed_at = now(), claimed_until = now() + interval '3 days'      where id = :'c_work';
update listing_candidates set last_seen_at = now() - interval '400 days',
       status = 'gone', gone_at = now() - interval '300 days'             where id = :'c_old';

insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fe001', 'flat', 'sale', 'Из кандидата', 65000,
        :'agent_bakyt');
insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
values ('00000000-0000-0000-0000-0000000fe001', 'non_exclusive', 65000, :'agent_bakyt', true, 'active');
update listing_candidates
   set last_seen_at = now() - interval '400 days', status = 'taken',
       claimed_by_agent_id = :'agent_bakyt', claimed_at = now() - interval '399 days',
       claimed_until = now() - interval '396 days',
       object_id = '00000000-0000-0000-0000-0000000fe001'
 where id = :'c_taken';

set role authenticated;
set request.jwt.claims = :'claims_admin';

-- ---- 14б. Просрочка видна до очистки --------------------------------------
-- Представление существует ровно для того, чтобы молчащий планировщик было
-- видно, а не предполагалось.
select test.eq((select phones_overdue from candidate_retention_v), 1::bigint,
  'один телефон просрочен');
-- Старых записей две, но одна стала объектом и срока хранения не имеет вовсе.
select test.eq((select records_overdue from candidate_retention_v), 1::bigint,
  'просрочена одна запись из двух старых');
select test.eq((select phone_ttl_days from candidate_retention_v), 30,
  'срок хранения телефона объявлен');

-- ---- 14в. Очистка убирает просроченный телефон ----------------------------
select * from app.purge_candidates() \gset purge_
select test.eq(:'purge_phones_removed'::int, 1, 'удалён один телефон');

set role postgres;
select test.eq(
  (select count(*)::int from listing_candidate_phones where candidate_id = :'c_idle'), 0,
  'телефон давно не виденного объявления удалён');

-- ---- 14г. Живое объявление и работа агента не трогаются -------------------
select test.eq(
  (select count(*)::int from listing_candidate_phones where candidate_id = :'c_live'), 1,
  'телефон свежего объявления на месте');
select test.eq(
  (select count(*)::int from listing_candidate_phones where candidate_id = :'c_work'), 1,
  'телефон взятого в работу не удаляется, даже если объявление старое');
select test.eq(
  (select count(*)::int from listing_candidate_phones where candidate_id = :'c_taken'), 1,
  'телефон кандидата, ставшего объектом, не удаляется');

-- ---- 14д. Ставший объектом не удаляется никогда ---------------------------
select test.eq(:'purge_candidates_removed'::int, 1,
  'удалена одна запись, а не обе старые');
select test.eq(
  (select count(*)::int from listing_candidates where id = :'c_taken'), 1,
  'кандидат, ставший объектом, остался: это история сделки');
select test.eq(
  (select count(*)::int from listing_candidates where id = :'c_old'), 0,
  'запись, которой вышел срок, удалена');

-- ---- 14е. После удаления записи от неё не остаётся следа ------------------
-- Само удаление — тоже событие, и триггер инварианта 7 дописывает в журнал
-- всю строку целиком. Поэтому журнал чистится после удаления, а не до.
set role collector;
select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','RET-TRACE','title','следов быть не должно',
  'kind','flat','deal_type','sale','price',66000,'author','owner',
  'phone', :'phone_trace',
  'description','Собственник. Телефон ' || :'phone_trace')) as c_trace \gset

set role postgres;
update listing_candidates set price = 67000 where id = :'c_trace';
update listing_candidates set last_seen_at = now() - interval '400 days'
 where id = :'c_trace';

select test.ok(
  (select count(*) from audit_log
    where entity_type = 'candidate' and entity_id = :'c_trace') >= 2,
  'журнал по кандидату заполнен до очистки');

set role authenticated;
select * from app.purge_candidates() \gset p2_

set role postgres;
select test.eq(
  (select count(*)::int from audit_log
    where entity_type = 'candidate' and entity_id = :'c_trace'), 0,
  'журнал по удалённому кандидату вычищен вместе с ним');

select test.eq(
  (select count(*)::int from audit_log where diff::text like '%111006%'), 0,
  'номера нет в журнале ни в одной записи');
select test.eq(
  (select count(*)::int from listing_candidates where raw::text like '%111006%'), 0,
  'номера нет в сырых данных кандидатов');
select test.eq(
  (select count(*)::int from listing_candidate_phones where phone like '%111006%'), 0,
  'номера нет в таблице телефонов');

-- ---- 14ж. Повторный вызов ничего не ломает --------------------------------
set role authenticated;
select * from app.purge_candidates() \gset p3_
select test.eq(:'p3_phones_removed'::int, 0, 'повторная очистка телефонов не находит');
select test.eq(:'p3_candidates_removed'::int, 0, 'повторная очистка записей не находит');

select test.eq((select phones_overdue from candidate_retention_v), 0::bigint,
  'просрочки по телефонам не осталось');
select test.eq((select records_overdue from candidate_retention_v), 0::bigint,
  'просрочки по записям не осталось');
