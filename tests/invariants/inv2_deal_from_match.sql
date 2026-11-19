-- ИНВАРИАНТ 2. Сделка создаётся только из подбора.
--              Закрытие сделки закрывает её мандат и её потребность.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- ---- 2а. Сделки без подбора не существует --------------------------------
-- match_id NOT NULL: обойти нечем.
select test.throws(
  format($$insert into deals (object_id, requirement_id, mandate_id,
                              listing_agent_id, closing_agent_id)
           values (%L, %L, %L, %L, %L)$$,
          :'obj1', :'req1', :'mandate1', :'agent_aibek', :'agent_bakyt'),
  'INVARIANT_2',
  'сделка без подбора отклонена');

-- ---- 2б. Сделка из подбора проходит --------------------------------------
select * from create_match(:'obj1', :'req1') \gset match1_
select test.ok(:'match1_id' is not null, 'подбор создан');

select * from create_deal_from_match(:'match1_id') \gset deal1_
select test.eq(:'deal1_status'::text, 'deposit', 'сделка создана из подбора');

-- Стороны комиссии подставлены сервером, а не запросом (инвариант 3).
select test.eq(:'deal1_listing_agent_id'::text, :'agent_aibek'::text, 'listing_agent взят из мандата');
select test.eq(:'deal1_closing_agent_id'::text, :'agent_bakyt'::text, 'closing_agent взят из подбора');

-- ---- 2в. Ссылки нельзя развести руками -----------------------------------
select test.throws(
  format($$update deals set object_id = %L where id = %L$$, :'obj2', :'deal1_id'),
  'INVARIANT_2',
  'объект сделки нельзя подменить на чужой');

select test.throws(
  format($$update deals set listing_agent_id = %L where id = %L$$, :'agent_chyngyz', :'deal1_id'),
  'INVARIANT_3',
  'listing_agent нельзя подменить вручную');

-- ---- 2г. Закрытие закрывает мандат и потребность -------------------------
select * from close_deal(:'deal1_id', 82000) \gset closed_
select test.eq(:'closed_status'::text, 'closed', 'сделка закрыта');

select test.eq(
  (select status from mandates where id = :'mandate1'), 'closed_by_deal'::mandate_status,
  'закрытие сделки закрыло её мандат');

select test.eq(
  (select status from requirements where id = :'req1'), 'closed'::requirement_status,
  'закрытие сделки закрыло её потребность');

-- Цепочка идёт дальше: мандат закрыт, значит объект ушёл из каталога.
select test.eq(
  (select publication_state from objects where id = :'obj1'), 'withdrawn'::publication_state,
  'проданный объект снят с публикации');

-- ---- 2д. Из отклонённого подбора сделки нет ------------------------------
select * from create_match(:'obj2', :'req2') \gset m2_
update matches set status = 'rejected', rejection_reason = 'не подошёл этаж' where id = :'m2_id';
select test.throws(
  format($$select create_deal_from_match(%L)$$, :'m2_id'),
  'INVARIANT_2',
  'сделка из отклонённого подбора невозможна');
