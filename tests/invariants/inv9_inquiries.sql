-- ИНВАРИАНТ 9. Обращение закрывается ровно одним исходом, и исход окончателен.
--   спрос уходит в потребность, предложение — в объект;
--   отказ обязан иметь причину;
--   закрытое обращение не переписывается.
\i tests/actors.sql
\set ON_ERROR_STOP on

set request.jwt.claims = :'claims_bakyt';
set role authenticated;

-- ---- 9а. Обращение фиксируется с каналом и источником -------------------
select * from register_inquiry(
  'lalafo'::inquiry_channel, 'demand'::inquiry_intent,
  'объявление по Киевской'::text, 'Азамат'::text, '0700 55-66-77'::text,
  'ищет двушку до 80 тысяч'::text) \gset i1_

select test.eq(:'i1_status'::text, 'new', 'обращение заведено новым');
select test.eq(:'i1_received_by_agent_id'::text, :'agent_bakyt'::text,
  'принявший агент это текущий агент');
-- NULL-колонку через \gset не прочитать: psql не задаёт переменную вовсе,
-- и ссылка на неё становится синтаксической ошибкой. Поэтому запросом.
select test.ok(
  (select closed_at from inquiries where id = :'i1_id') is null,
  'у открытого обращения нет даты закрытия');

-- Телефон приведён к единому виду: иначе один человек, позвонивший дважды,
-- в отчёте будет двумя разными.
select test.eq(:'i1_contact_phone'::text, '+996700556677',
  'номер обращения нормализован');

-- ---- 9б. Мусорный номер не отбрасывает обращение -------------------------
-- Сознательно мягче, чем у агента: отказать во всей записи из-за опечатки
-- значит потерять лид.
select * from register_inquiry(
  'phone'::inquiry_channel, 'unknown'::inquiry_intent,
  null::text, 'Без номера'::text, 'не расслышал'::text, null::text) \gset i2_
select test.eq(:'i2_contact_phone'::text, 'не расслышал',
  'неразборчивый номер сохранён как есть, обращение не потеряно');

-- ---- 9в. Открытое обращение не имеет исхода ------------------------------
select test.throws(
  format($$update inquiries set requirement_id = %L where id = %L$$,
         :'req1', :'i1_id'),
  'inquiries_one_outcome',
  'ссылку на исход нельзя поставить открытому обращению');

select test.throws(
  format($$update inquiries set status = 'converted' where id = %L$$, :'i1_id'),
  'ровно одним исходом',
  'закрыть обращение без исхода нельзя');

-- ---- 9г. Исход ровно один -------------------------------------------------
select test.throws(
  format($$select convert_inquiry(%L, %L, %L)$$, :'i1_id', :'req1', :'obj1'),
  'INVARIANT_9',
  'два исхода сразу отклонены');

select test.throws(
  format($$select convert_inquiry(%L)$$, :'i1_id'),
  'INVARIANT_9',
  'ни одного исхода тоже нельзя');

-- ---- 9д. Намерение и исход должны сходиться ------------------------------
-- Обращение со спросом нельзя закрыть объектом: иначе воронка по намерению
-- считает одно, а ссылки ведут в другое.
select test.throws(
  format($$select convert_inquiry(%L, null, %L)$$, :'i1_id', :'obj1'),
  'INVARIANT_9',
  'спрос нельзя закрыть объектом');

select * from register_inquiry(
  'walk_in'::inquiry_channel, 'supply'::inquiry_intent,
  'пришёл в офис'::text, 'Собственник'::text, '0555111222'::text,
  'хочет сдать квартиру'::text) \gset i3_
select test.throws(
  format($$select convert_inquiry(%L, %L)$$, :'i3_id', :'req1'),
  'INVARIANT_9',
  'предложение нельзя закрыть потребностью');

-- ---- 9е. Нормальный путь: спрос в потребность ----------------------------
select * from qualify_inquiry(:'i1_id') \gset q1_
select test.eq(:'q1_status'::text, 'qualified', 'обращение разобрано');

select * from convert_inquiry(:'i1_id', :'req1') \gset c1_
select test.eq(:'c1_status'::text, 'converted', 'обращение превратилось в потребность');
select test.ok(:'c1_closed_at' is not null, 'дата закрытия проставлена');
select test.eq(:'c1_requirement_id'::text, :'req1'::text, 'ссылка на потребность стоит');
select test.ok(
  (select object_id from inquiries where id = :'i1_id') is null,
  'второй ссылки нет');

-- Контакт выведен сервером из потребности, а не передан запросом.
select test.eq(:'c1_contact_id'::text, :'contact_client'::text,
  'контакт выведен из потребности на сервере');

-- ---- 9ж. Закрытое обращение не переписывается ----------------------------
select test.throws(
  format($$select reject_inquiry(%L, 'передумал')$$, :'i1_id'),
  'INVARIANT_9',
  'закрытое обращение нельзя отклонить задним числом');

select test.throws(
  format($$update inquiries set requirement_id = %L where id = %L$$,
         :'req2', :'i1_id'),
  'INVARIANT_9',
  'ссылку закрытого обращения нельзя переставить');

select test.throws(
  format($$update inquiries set source = 'другая реклама' where id = %L$$, :'i1_id'),
  'INVARIANT_9',
  'источник закрытого обращения не переписывается');

-- Дописать контакт разрешено: кто звонил, выясняется и позже.
update inquiries set contact_name = 'Азамат Осмонов' where id = :'i1_id';
select test.eq((select contact_name from inquiries where id = :'i1_id'),
  'Азамат Осмонов', 'имя у закрытого обращения дописать можно');

-- ---- 9з. Отказ обязан иметь причину --------------------------------------
select test.throws(
  format($$select reject_inquiry(%L, '   ')$$, :'i2_id'),
  'INVARIANT_9',
  'отказ без причины отклонён');

select test.throws(
  format($$update inquiries set status = 'rejected', closed_at = now() where id = %L$$,
         :'i2_id'),
  'inquiries_rejection_has_reason',
  'отказ без причины отклонён и прямым UPDATE');

select * from reject_inquiry(:'i2_id', 'номер не отвечает третий день') \gset r2_
select test.eq(:'r2_status'::text, 'rejected', 'обращение отклонено');
select test.ok(:'r2_closed_at' is not null, 'отказ тоже закрывает обращение');

-- ---- 9и. Воронка по каналам ----------------------------------------------
select test.eq(
  (select converted from inquiry_funnel_v
    where channel = 'lalafo' and source = 'объявление по Киевской'),
  1::bigint, 'воронка видит превращение по каналу lalafo');

select test.eq(
  (select conversion_pct from inquiry_funnel_v
    where channel = 'lalafo' and source = 'объявление по Киевской'),
  100.0::numeric, 'конверсия канала посчитана');

-- Спам не входит в знаменатель конверсии: это шум, а не поток.
select * from register_inquiry('site'::inquiry_channel) \gset s1_
select * from reject_inquiry(:'s1_id', 'реклама бурения скважин', true) \gset s1r_
select test.eq(:'s1r_status'::text, 'spam', 'обращение помечено спамом');
select test.ok(
  (select conversion_pct from inquiry_funnel_v
    where channel = 'site' and source is null) is null,
  'канал из одного спама конверсии не имеет, а не нулевую');

-- ---- 9к. Видимость: принявший агент и админ ------------------------------
set request.jwt.claims = :'claims_chyngyz';
select test.eq(
  test.visible_count(format($$select 1 from inquiries where id = %L$$, :'i1_id')),
  0::bigint, 'чужое обращение постороннему агенту не видно');

set request.jwt.claims = :'claims_admin';
select test.eq(
  test.visible_count(format($$select 1 from inquiries where id = %L$$, :'i1_id')),
  1::bigint, 'админу видна вся история обращений');

-- ---- 9л. Обращение в журнале (инвариант 7) -------------------------------
select test.ok(
  (select count(*) from audit_log
    where entity_type = 'inquiry' and entity_id = :'i1_id') >= 3,
  'приём, разбор и закрытие обращения записаны в журнал');
