-- Права в функциях слоя доступа (миграция 0016).
--
-- Регрессия на три дыры, найденные на схеме до 0016. Функции объявлены
-- SECURITY DEFINER, то есть RLS их не касается — значит проверка должна быть
-- внутри них, и этот файл обязан падать, если она исчезнет.
\i tests/actors.sql
\set ON_ERROR_STOP on

-- Законная сделка Айбека (listing) и Бакыта (closing по своей потребности).
set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select * from create_match(:'obj1', :'req1') \gset m_
select * from create_deal_from_match(:'m_id') \gset d_
reset role;

select test.ok((select app.is_deal_party(:'d_id')) is not null, 'сделка создана');

-- ===========================================================================
-- ДЫРА 1: посторонний закрывал чужую сделку и фиксировал комиссию
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;

select test.ok(not app.is_deal_party(:'d_id'), 'Чынгыз не участник сделки');

select test.throws(
  format($$select close_deal(%L, 999000)$$, :'d_id'),
  'закрыть сделку может только её участник',
  'посторонний НЕ закрывает чужую сделку');

select test.throws(
  format($$select fail_deal(%L, 'по приколу')$$, :'d_id'),
  'сорвать сделку может только её участник',
  'посторонний НЕ срывает чужую сделку');

select test.throws(
  format($$select set_deal_status(%L, 'signing')$$, :'d_id'),
  'менять этап сделки может только её участник',
  'посторонний НЕ двигает чужую сделку по этапам');
reset role;

-- Комиссия не зафиксирована, сделка не тронута.
select test.eq((select status from deals where id = :'d_id'), 'deposit'::deal_status,
  'сделка осталась на этапе аванса');
select test.ok((select commission_total is null from deals where id = :'d_id'),
  'комиссия не зафиксирована');

-- ===========================================================================
-- ДЫРА 2: посторонний снимал чужой объект с публикации
-- ===========================================================================

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.throws(
  format($$select withdraw_object(%L)$$, :'obj2'),
  'FORBIDDEN',
  'посторонний НЕ снимает чужой объект с публикации');
select test.throws(
  format($$select publish_object(%L)$$, :'obj2'),
  'FORBIDDEN',
  'посторонний НЕ публикует чужой объект');
select test.throws(
  format($$select app.confirm_actual(%L)$$, :'obj2'),
  'FORBIDDEN',
  'посторонний НЕ подтверждает актуальность чужого объекта');
-- А вот договор заключить он может, и это осознанно: объект мог внести один
-- агент, а контракт с собственником быть у другого. Запрет ломал бы честный
-- случай каждый раз. Риск покрыт журналом — видно, кто завёл мандат.
reset role;
insert into objects (id, kind, deal_type, address, price, created_by_agent_id)
values ('00000000-0000-0000-0000-0000000fd001', 'flat', 'sale', 'Внёс один, договор у другого',
        65000, :'agent_aibek');

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select * from create_mandate('00000000-0000-0000-0000-0000000fd001', 'exclusive'::mandate_kind) \gset fm_
select test.eq(:'fm_listing_agent_id'::text, :'agent_chyngyz'::text,
  'договор на объект, внесённый другим, заключить можно: listing-агент тот, кто принёс контракт');
-- И теперь он отвечает за объект: может его публиковать.
select test.eq((publish_object('00000000-0000-0000-0000-0000000fd001')).publication_state,
  'published'::publication_state,
  'принёсший договор получает право публиковать объект');
reset role;

select test.ok(
  (select count(*) > 0 from audit_log
    where entity_type = 'mandate' and action = 'insert'
      and actor_agent_id = :'agent_chyngyz'::uuid),
  'журнал записал, кто завёл мандат: захват был бы виден');

select test.eq((select publication_state from objects where id = :'obj2'),
  'published'::publication_state, 'объект остался опубликованным');

-- ===========================================================================
-- ДЫРА 3: посторонний назначал СЕБЯ closing-агентом на чужого клиента
-- ===========================================================================
-- Самая дорогая из трёх: по инварианту 3 доля closing-агента идёт тому, кто
-- указан в подборе. Теперь closing_agent берётся из ПОТРЕБНОСТИ.

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select * from create_match(:'obj3', :'req2') \gset cm_

select test.eq(:'cm_closing_agent_id'::text, :'agent_bakyt'::text,
  'closing-агент взят из потребности (Бакыт), а НЕ тот, кто нажал (Чынгыз)');
select test.eq(:'cm_created_by_agent_id'::text, :'agent_chyngyz'::text,
  'но автор подбора записан честно: предлагать объект чужому клиенту можно');

-- Комиссия по этому подбору достанется Бакыту, а не Чынгызу.
select test.eq(
  (select closing_agent_id from match_commission_v where match_id = :'cm_id')::text,
  :'agent_bakyt'::text, 'доля closing-агента посчитана на агента клиента');

-- И сделку по чужому подбору он не создаст.
select test.throws(
  format($$select create_deal_from_match(%L)$$, :'cm_id'),
  'FORBIDDEN',
  'посторонний НЕ создаёт сделку по подбору, где он не сторона');
reset role;

-- ===========================================================================
-- Участники делают всё это свободно
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq((set_deal_status(:'d_id', 'documents'::deal_status)).status,
  'documents'::deal_status, 'closing-агент двигает сделку по этапам');
reset role;

set request.jwt.claims = :'claims_aibek';
set role authenticated;
select test.eq((set_deal_status(:'d_id', 'signing'::deal_status)).status,
  'signing'::deal_status, 'listing-агент тоже двигает сделку');

-- Завершение через этапы не проходит: у закрытия и срыва свои функции.
select test.throws(
  format($$select set_deal_status(%L, 'closed')$$, :'d_id'),
  'close_deal',
  'закрыть сделку сменой этапа нельзя: нужна финальная цена');
select test.throws(
  format($$select set_deal_status(%L, 'failed')$$, :'d_id'),
  'fail_deal',
  'сорвать сделку сменой этапа нельзя: нужна причина');

-- Закрытие участником работает и фиксирует обе доли.
select * from close_deal(:'d_id', 88000) \gset cl_
select test.eq(:'cl_commission_total'::numeric, 1760.00::numeric,
  'комиссия зафиксирована от финальной цены');
select test.eq(:'cl_listing_share'::numeric, 880.00::numeric, 'доля listing зафиксирована');
select test.eq(:'cl_closing_share'::numeric, 880.00::numeric, 'доля closing зафиксирована');

-- Завершённую сделку по этапам не двигают.
select test.throws(
  format($$select set_deal_status(%L, 'documents')$$, :'d_id'),
  'уже завершена',
  'завершённую сделку по этапам не двигают');
reset role;

-- ===========================================================================
-- Админ может всё
-- ===========================================================================
set request.jwt.claims = :'claims_admin';
set role authenticated;
select test.ok(app.is_deal_party(:'d_id'), 'админ считается стороной любой сделки');
select test.eq((withdraw_object(:'obj2')).publication_state, 'withdrawn'::publication_state,
  'админ снимает любой объект');
reset role;

-- ===========================================================================
-- Список сделок и инвариант 4 в нём
-- ===========================================================================

set request.jwt.claims = :'claims_bakyt';
set role authenticated;
select test.eq((select client_name from deal_list_v where id = :'d_id'),
  'Жумаев Клиент', 'участник видит клиента в списке сделок');
select test.ok((select can_act from deal_list_v where id = :'d_id'),
  'участнику список говорит, что действия доступны');
reset role;

set request.jwt.claims = :'claims_chyngyz';
set role authenticated;
select test.eq(test.visible_count(format($$select 1 from deal_list_v where id = %L$$, :'d_id')),
  1::bigint, 'посторонний ВИДИТ сделку в списке: комиссия агентам открыта');
select test.ok((select client_name is null from deal_list_v where id = :'d_id'),
  'но клиент у него пуст');
select test.ok((select owners is null from deal_list_v where id = :'d_id'),
  'и собственник пуст');
select test.ok((select commission_total is not null from deal_list_v where id = :'d_id'),
  'а комиссия видна');
select test.ok((select not can_act from deal_list_v where id = :'d_id'),
  'и список говорит, что действия ему недоступны');
reset role;

reset request.jwt.claims;
set role anon;
select test.throws($$select 1 from deal_list_v$$, 'permission denied',
  'список сделок анониму недоступен');
reset role;
