-- db/dev_seed_cabinet.sql — данные для разработки кабинета. НЕ приёмка.
--
-- Нужен по той же причине, что dev_seed.sql для каталога: на пустых экранах
-- не видно ни очереди, ни сортировки, ни того, как выглядит просроченное
-- обращение. Экран, который разработчик видел только пустым, в первый день
-- работы агентства ведёт себя неожиданно.
--
-- Применяется ПОСЛЕ tests/seed.sql и db/dev_seed.sql.
--
--   psql -d partner -f db/dev_seed_cabinet.sql

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Обращения на входе
-- ---------------------------------------------------------------------------
-- Разный возраст задаётся при вставке: обращение, ждущее сутки, должно быть
-- видно как просроченное, а не как новое.
do $$
declare
  v_agent uuid := (select id from agents where full_name = 'Айбек');
  r       record;
  v_id    uuid;
begin
  for r in
    select * from (values
      -- канал,    намерение,  имя,                 телефон,        часов назад, текст
      ('site',     'demand',  'Нургуль Сапарова',  '0555 112 233',  2, 'Ищу двушку в центре до 80 тысяч, можно без ремонта.'),
      ('whatsapp', 'demand',  'Азамат',            '0700 445 566', 14, 'Снять однушку рядом с Ала-Тоо, бюджет 300.'),
      ('phone',    'supply',  'Гульмира Токтоева', '0771 889 900', 30, 'Хочу продать квартиру на Горького, звонили из трёх агентств.'),
      ('site',     'supply',  'Эркин',             '0550 221 144', 52, 'Сдаю дом в Чон-Арыке, нужен агент.'),
      ('whatsapp', 'unknown', NULL,                '0709 000 111',  6, 'Участок в Ала-Арче есть?'),
      ('site',     'unknown', 'Реклама',           '0000 000 000',  8, 'Предлагаем SEO-продвижение вашего сайта!')
    ) as v(channel, intent, name, phone, hours_ago, body)
  loop
    insert into inquiries (channel, intent, contact_name, contact_phone, body,
                           received_by_agent_id, received_at)
    values (r.channel::inquiry_channel, r.intent::inquiry_intent, r.name, r.phone,
            r.body, v_agent, now() - (r.hours_ago || ' hours')::interval)
    returning id into v_id;
  end loop;

  -- Одно уже разобрано, одно отклонено как спам: иначе не видно, как
  -- выглядит очередь с историей.
  --
  -- Отказ ставится настоящей функцией, а не правкой статуса: статус, причина
  -- и дата закрытия связаны ограничением, и обойти его означало бы завести в
  -- базе состояние, которого в жизни не бывает. Функция требует одобренного
  -- агента, поэтому клеймы выставляются так же, как это делает кабинет.
  update inquiries set status = 'qualified'
   where contact_name = 'Азамат';

  perform set_config('request.jwt.claims',
    json_build_object('sub', (select auth_user_id from agents where id = v_agent),
                      'role', 'authenticated')::text, true);

  perform reject_inquiry(id, 'реклама услуг, не обращение клиента', true)
     from inquiries where contact_name = 'Реклама';

  -- Сбрасывается пустым ОБЪЕКТОМ, а не пустой строкой: auth.uid() разбирает
  -- это значение как JSON, и '' роняет следующий же запрос с «invalid input
  -- syntax for type json» — в месте, никак не похожем на причину.
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- Объявления с площадок
-- ---------------------------------------------------------------------------
-- Заводятся настоящим путём — через функцию приёма от имени роли сборщика,
-- иначе проверялся бы не тот путь, которым они приходят в бою. Телефоны
-- выдуманные: чужой номер в репозитории хранить незачем.
set role collector;

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','DEV-1','url','https://www.house.kg/details/dev-1',
  'title','2-комн. кв., 54 м², 4 этаж из 9','description','Собственник, срочно. Торг.',
  'address','город Бишкек, 7 м-н','zone','7 м-н','kind','flat','deal_type','sale',
  'rooms',2,'area',54,'floor',4,'floors_total',9,'price',4700000,'currency','KGS',
  'photos_count',8,'author','owner','phone','0700 777 101'));

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','DEV-2','url','https://www.house.kg/details/dev-2',
  'title','1-комн. кв., 38 м², 2 этаж из 5','description','От хозяина. Звонить после 18.',
  'address','город Бишкек, Юг-2','zone','Юг-2','kind','flat','deal_type','rent',
  'rooms',1,'area',38,'floor',2,'floors_total',5,'price',28000,'currency','KGS',
  'photos_count',5,'author','owner','phone','0555 777 102'));

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','DEV-3','url','https://www.house.kg/details/dev-3',
  'title','Дом, 180 м², Чон-Арык','description','Собственник. Документы готовы.',
  'address','город Бишкек, Чон-Арык','zone','Чон-Арык','kind','house','deal_type','sale',
  'rooms',5,'area',180,'price',9200000,'currency','KGS',
  'photos_count',12,'author','owner'));

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','DEV-4','url','https://www.house.kg/details/dev-4',
  'title','3-комн. кв., 88 м², 11 этаж из 12','description','Агентство недвижимости «Дом».',
  'address','город Бишкек, Центр','zone','Центр','kind','flat','deal_type','sale',
  'rooms',3,'area',88,'floor',11,'floors_total',12,'price',11800000,'currency','KGS',
  'photos_count',15,'author','agent','phone','0312 900 900'));

select app.upsert_candidate(jsonb_build_object(
  'source','house_kg','external_id','DEV-5','url','https://www.house.kg/details/dev-5',
  'title','Участок 8 соток, Ала-Арча','description','Хозяин. Красная книга.',
  'address','город Бишкек, Ала-Арча','zone','Ала-Арча','kind','land','deal_type','sale',
  'area',800,'price',3600000,'currency','KGS','photos_count',3,'author','owner',
  'phone','0770 777 105'));

reset role;

-- Одно объявление уже взято Айбеком: так видно, как выглядит «в работе у вас»
-- и что телефон виден только взявшему.
do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_cand  uuid := (select id from listing_candidates where external_id = 'DEV-1');
begin
  update listing_candidates
     set status = 'in_work', claimed_by_agent_id = v_aibek,
         claimed_at = now(), claimed_until = now() + interval '3 days'
   where id = v_cand;
end $$;

select 'обращений: ' || count(*) from inquiries
union all
select 'кандидатов: ' || count(*) from listing_candidates;
