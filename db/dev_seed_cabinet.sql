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

-- ---------------------------------------------------------------------------
-- День показов
-- ---------------------------------------------------------------------------
-- dev_seed.sql даёт три показа по одному подбору. Для экрана показов этого
-- мало: не видно ни дня из нескольких встреч, ни просроченного показа, ни
-- того, как читается неявка рядом с состоявшимся показом.
--
-- Время задаётся по Бишкеку и круглыми часами: показ в 01:18 ночи, который
-- получается из now(), на снимке экрана выглядит ошибкой, а не данными.
do $$
declare
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  v_req   uuid := (select id from requirements
                    where requirements_text like 'Квартира для себя%');
  v_today date := (now() at time zone 'Asia/Bishkek')::date;
  r       record;
  v_match uuid;
begin
  for r in
    select * from (values
      -- адрес объекта,                дней, час, состояние,   исход,          слова клиента
      ('Горького 183, кв. 7',             0, 11, 'scheduled',  null,           null),
      ('Исанова 105, кв. 61',             0, 15, 'scheduled',  null,           null),
      ('Московская 217, кв. 9',           1, 10, 'scheduled',  null,           null),
      ('Жукеева-Пудовкина 77, кв. 3',     2, 17, 'scheduled',  null,           null),
      -- время прошло, исход не записан: так выглядит забытый показ
      ('Киевская 148, кв. 44',           -1, 12, 'scheduled',  null,           null),
      ('Байтик Баатыра 41, кв. 18',      -3, 16, 'done',      'wants_bargain', 'нравится, но просит минус 4000'),
      ('Ахунбаева 134, кв. 72',          -4, 14, 'no_show',    null,           null)
    ) as t(address, day_shift, hour, status, outcome, reaction)
  loop
    select m.id into v_match from matches m
      join objects o on o.id = m.object_id
     where m.requirement_id = v_req and o.address = r.address;

    if v_match is null then
      insert into matches (requirement_id, object_id, closing_agent_id, created_by_agent_id,
                           status)
      select v_req, o.id, v_bakyt, v_bakyt, 'interested'
        from objects o where o.address = r.address
      returning id into v_match;
    end if;

    if v_match is not null then
      insert into showings (match_id, agent_id, scheduled_at, done_at, status, outcome,
                            client_reaction, created_by_agent_id)
      values (v_match, v_bakyt,
              ((v_today + r.day_shift)::timestamp + make_interval(hours => r.hour))
                at time zone 'Asia/Bishkek',
              case when r.status = 'done'
                   then ((v_today + r.day_shift)::timestamp + make_interval(hours => r.hour + 1))
                          at time zone 'Asia/Bishkek' end,
              r.status::showing_status,
              r.outcome::showing_outcome,
              r.reaction,
              v_bakyt);
    end if;
  end loop;
end $$;

-- Чужой показ по тому же объекту в тот же час. База это не запрещает
-- (инвариант 26), а календарь показывает: у двери окажутся две группы.
do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  v_req   uuid := (select id from requirements
                    where requirements_text like 'Дом под расширение%');
  v_obj   uuid := (select id from objects where address = 'Московская 217, кв. 9');
  v_at    timestamptz := (select scheduled_at from showings s
                            join matches m on m.id = s.match_id
                           where m.object_id = (select id from objects
                                                 where address = 'Московская 217, кв. 9')
                             and s.status = 'scheduled'
                           limit 1);
  v_match uuid;
begin
  if v_at is null or v_req is null then return; end if;

  select m.id into v_match from matches m
   where m.object_id = v_obj and m.requirement_id = v_req;

  if v_match is null then
    insert into matches (requirement_id, object_id, closing_agent_id,
                         created_by_agent_id, status)
    values (v_req, v_obj, v_bakyt, v_bakyt, 'interested')
    returning id into v_match;
  end if;

  insert into showings (match_id, agent_id, scheduled_at, status, created_by_agent_id)
  values (v_match, v_aibek, v_at + interval '30 minutes', 'scheduled', v_aibek);
end $$;

-- ---------------------------------------------------------------------------
-- Воронка и задачи
-- ---------------------------------------------------------------------------
-- На двух клиентах воронки не видно: ни пустых колонок, ни вставших карточек,
-- ни того, что карточка переезжает сама. Клиенты заводятся настоящим путём —
-- функциями от имени агента, — потому что статусы теперь проверяются фактами
-- (инвариант 30), и «просто вписать in_deal» база не даст. Это и есть
-- проверка модели данными.

do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  r       record;
  v_req   uuid;
  v_obj   uuid;
  v_match uuid;
  v_show  uuid;
  v_day   date := (now() at time zone 'Asia/Bishkek')::date;
begin
  for r in
    select * from (values
      -- Телефоны выдуманные: чужой номер в репозитории хранить незачем.
      -- имя,                 телефон,        агент, сделка, от,     до,     районы,      комнаты, куда довести, дней назад
      ('Нургуль Сапарова',  '0555 201 001', 1, 'sale', 70000,  95000,  '{Центр}',    '{2}',   'new',         0),
      ('Азамат Осмонов',    '0555 201 002', 1, 'rent', 250,    400,    '{Центр,Юг}', '{1}',   'new',         5),
      ('Гульмира Токтоева', '0555 201 003', 2, 'sale', 100000, 150000, '{Центр}',    '{3}',   'qualified',   2),
      ('Эркин Бейшеналиев', '0555 201 004', 1, 'sale', 150000, 220000, '{Юг,Запад}', '{4,5}', 'qualified',  40),
      ('Айжан Кадырова',    '0555 201 005', 2, 'rent', 400,    700,    '{Центр}',    '{2,3}', 'showings',    7),
      ('Марат Сыдыков',     '0555 201 006', 1, 'sale', 55000,  95000,  '{Центр}',    '{1,2}', 'deal',        3),
      ('Данияр Токтосунов', '0555 201 008', 2, 'sale', 60000,  90000,  '{Юг}',       '{1,2}', 'closed',      1),
      ('Бегимай Асанова',   '0555 201 007', 2, 'sale', 60000,  90000,  '{Юг}',       '{2}',   'lost',       12)
    ) as v(name, phone, agent_no, deal_type, lo, hi, zones, rooms, target, days_ago)
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select auth_user_id from agents
                                 where id = case r.agent_no when 1 then v_aibek else v_bakyt end),
                        'role', 'authenticated')::text, true);

    select id into v_req from create_requirement(
      r.deal_type::deal_type, null, r.name, r.phone, r.lo, r.hi,
      r.zones::text[], r.rooms::smallint[]);

    if r.target in ('qualified', 'showings', 'deal', 'closed') then
      perform qualify_requirement(v_req);
    end if;

    if r.target in ('showings', 'deal', 'closed') then
      -- Подходящий объект берём подбором, а не наугад: иначе инвариант 20
      -- откажет, и сеяние молча потеряет половину клиентов.
      select object_id into v_obj from app.matching_objects(v_req) limit 1;
      if v_obj is not null then
        select id into v_match from create_match(v_obj, v_req);

        if r.target = 'showings' then
          -- Показ в прошлом, но внутри срока отката (инвариант 25) и в
          -- рабочих часах (инвариант 26).
          select id into v_show from schedule_showing(
            v_match, (v_day - 1 + time '14:00') at time zone 'Asia/Bishkek');
          perform complete_showing(v_show, 'thinking', 'сравнивает с другими');
        else
          perform create_deal_from_match(v_match);
          if r.target = 'closed' then
            -- Закрытие сделки закрывает и клиента (инвариант 2), и колонка
            -- «Купил» наполняется фактом, а не правкой статуса.
            perform close_deal((select id from deals
                                 where requirement_id = v_req
                                   and status not in ('closed', 'failed')
                                 limit 1),
                               r.hi);
          end if;
        end if;
      end if;
    end if;

    if r.target = 'lost' then
      perform lose_requirement(v_req, 'купил напрямую у собственника');
    end if;

    -- Возраст карточки задаётся правкой даты входа в колонку: иначе все
    -- карточки «сегодня здесь» и вставших не видно вовсе.
    perform set_config('request.jwt.claims', '{}', true);
    update requirements set stage_since = now() - (r.days_ago || ' days')::interval
     where id = v_req;
  end loop;

  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- Задачи: просроченная, сегодняшняя, завтрашняя, сделанная и снятая. На
-- пустом экране не видно ни одного из пяти состояний.
do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  v_req   uuid := (select r.id from requirements r
                    join contacts c on c.id = r.contact_id
                   where c.name = 'Гульмира Токтоева' limit 1);
  v_req2  uuid := (select r.id from requirements r
                    join contacts c on c.id = r.contact_id
                   where c.name = 'Эркин Бейшеналиев' limit 1);
  v_obj   uuid := (select id from objects where address = 'Киевская 148, кв. 44');
  v_day   date := (now() at time zone 'Asia/Bishkek')::date;
  v_done  uuid;
  v_cancelled uuid;
begin
  insert into tasks (kind, title, due_at, agent_id, created_by_agent_id, requirement_id)
  values ('call', 'Перезвонить и назвать цену после торга',
          (v_day - 1 + time '11:00') at time zone 'Asia/Bishkek', v_aibek, v_aibek, v_req2),
         ('call', 'Перезвонить: Гульмира Токтоева',
          (v_day + time '17:00') at time zone 'Asia/Bishkek', v_bakyt, v_bakyt, v_req),
         ('meeting', 'Показать Джал и Асанбай подряд',
          (v_day + 1 + time '12:00') at time zone 'Asia/Bishkek', v_aibek, v_aibek, null),
         ('document', 'Забрать справку из Госрегистра',
          (v_day + 2 + time '09:30') at time zone 'Asia/Bishkek', v_aibek, v_aibek, null);

  insert into tasks (kind, title, due_at, agent_id, created_by_agent_id, object_id)
  values ('other', 'Переснять фотографии: тёмные',
          (v_day - 2 + time '15:00') at time zone 'Asia/Bishkek', v_aibek, v_aibek, v_obj)
  returning id into v_done;

  insert into tasks (kind, title, due_at, agent_id, created_by_agent_id)
  values ('call', 'Позвонить в банк по ипотеке клиента',
          (v_day - 3 + time '10:00') at time zone 'Asia/Bishkek', v_aibek, v_aibek)
  returning id into v_cancelled;

  -- Закрываются правкой, а не функцией: у сеяния нет входа, а правило
  -- «закрытая задача окончательна» проверяется в тестах, не здесь.
  update tasks set done_at = now() - interval '2 days',
                   done_note = 'переснял, загрузил пять штук'
   where id = v_done;
  update tasks set cancelled_at = now() - interval '1 day',
                   cancel_reason = 'клиент сам дозвонился'
   where id = v_cancelled;
end $$;

-- ---------------------------------------------------------------------------
-- Воронка объектов (инвариант 32)
-- ---------------------------------------------------------------------------
-- Все объекты каталога заведены сразу с договором, и на доске объектов видна
-- одна колонка из восьми. В жизни наоборот: больше всего карточек стоит до
-- договора — именно там агентство и теряет объекты.

do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  r       record;
  v_obj   uuid;
begin
  for r in
    select * from (values
      -- адрес,                          вид,     сделка, цена,   собственник,        телефон,        этап,          агент, дней назад
      ('Панфилова 108, кв. 3',          'flat',  'sale', 68000,  'Асанов Бекжан',    '0555 410 001', 'new',          1, 0),
      ('Ибраимова 24, кв. 51',          'flat',  'sale', 94000,  'Турсунова Жылдыз', '0555 410 002', 'new',          2, 4),
      ('Абдрахманова 150, кв. 9',       'flat',  'rent', 500,    'Касымов Нурбек',   '0555 410 003', 'new',          1, 9),
      ('Токтогула 93, кв. 17',          'flat',  'sale', 112000, 'Эрматов Руслан',   '0555 410 004', 'called',       1, 2),
      ('Байтик Баатыра 7, кв. 40',      'flat',  'rent', 380,    'Жээнбеков Канат',  '0555 410 005', 'called',       2, 8),
      ('Ахунбаева 51, кв. 22',          'flat',  'sale', 87000,  'Садыкова Айгуль',  '0555 410 006', 'visited',      1, 3),
      ('Чүй 219, кв. 64',               'flat',  'sale', 143000, 'Молдалиев Тимур',  '0555 410 007', 'visited',      2, 12),
      ('Манаса 40, кв. 8',              'flat',  'sale', 76000,  'Бакиров Азат',     '0555 410 008', 'no_contract',  1, 5),
      ('Сухэ-Батора 18, кв. 2',         'flat',  'rent', 420,    'Исакова Венера',   '0555 410 009', 'no_contract',  2, 20),
      ('Логвиненко 61, кв. 35',         'flat',  'sale', 99000,  'Нурланов Элдар',   '0555 410 010', 'contracted',   1, 6)
    ) as v(address, kind, deal_type, price, owner, phone, stage, agent_no, days_ago)
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select auth_user_id from agents
                                 where id = case r.agent_no when 1 then v_aibek else v_bakyt end),
                        'role', 'authenticated')::text, true);

    select id into v_obj from register_object(
      r.kind::object_kind, r.deal_type::deal_type, r.address, r.price,
      null, r.owner, r.phone);

    if r.stage in ('called', 'visited') then
      perform set_owner_stage(v_obj, 'called');
    end if;
    if r.stage = 'visited' then
      perform set_owner_stage(v_obj, 'visited');
    end if;

    -- «Без договора» — это заключённый, но не подписанный договор: агент
    -- работает на честном слове. Именно эта колонка и есть риск.
    if r.stage = 'no_contract' then
      perform sign_mandate(v_obj, 'non_exclusive');
    end if;
    if r.stage = 'contracted' then
      perform sign_mandate(v_obj, 'exclusive', current_date + 90, null, true);
    end if;

    perform set_config('request.jwt.claims', '{}', true);
    update objects set owner_stage_since = now() - (r.days_ago || ' days')::interval
     where id = v_obj;
  end loop;

  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- Кабинет собственника: одна ссылка на все его объекты (инвариант 29).
-- Без неё экран собственника в разработке нечем открыть.
do $$
declare
  v_aibek uuid := (select id from agents where full_name = 'Айбек');
  v_owner uuid := '00000000-0000-0000-0000-00000000c001';
begin
  insert into owner_access (object_id, contact_id, token, issued_by_agent_id, expires_at)
  values (null, v_owner, 'ccccccccddddeeeeffff000011112222', v_aibek,
          now() + interval '365 days')
  on conflict (token) do nothing;
end $$;

select 'обращений: ' || count(*) from inquiries
union all
select 'кандидатов: ' || count(*) from listing_candidates
union all
select 'показов: ' || count(*) from showings
union all
select 'кабинет собственника: /owner/ccccccccddddeeeeffff000011112222';

-- ---------------------------------------------------------------------------
-- Подборки (инвариант 36)
-- ---------------------------------------------------------------------------
-- Три состояния, которые на пустом экране не видны: черновик, отправленная и
-- неоткрытая, открытая с реакцией клиента. Именно различие между вторым и
-- третьим и есть смысл этой сущности.

do $$
declare
  v_bakyt uuid := (select id from agents where full_name = 'Бакыт');
  v_req   uuid;
  v_objs  uuid[];
  v_sel   uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select auth_user_id from agents where id = v_bakyt),
                      'role', 'authenticated')::text, true);

  -- Клиент не называется по имени: взять того, под кого подбор реально
  -- что-то находит. Имя в сеялке устаревает молча — объекты меняются, и
  -- демонстрация «подборки» вырождается в подборку из одного варианта.
  select r.id into v_req
    from requirements r
   where r.agent_id = v_bakyt
     and r.status not in ('closed', 'lost')
   order by (select count(*) from app.matching_objects(r.id)) desc,
            r.created_at
   limit 1;

  if v_req is not null then
    select array_agg(object_id) into v_objs
      from (select object_id from app.matching_objects(v_req) limit 3) t;

    if coalesce(array_length(v_objs, 1), 0) > 0 then
      -- Черновик: состав ещё можно менять.
      -- Тексты не называют число вариантов: подбор мог дать и один объект,
      -- и тогда «собрал три варианта» рядом с «1 объект» читается как
      -- поломка экрана, хотя поломки нет.
      select id into v_sel from create_selection(v_req, v_objs,
        'Собрал то, что сейчас есть, посмотрите');

      -- Отправленная и открытая, с реакцией.
      select id into v_sel from create_selection(v_req, v_objs[1:2],
        'В центре, смотреть можно завтра');
      perform send_selection(v_sel);
      -- Реакции ставятся по фактическому составу подборки, а не по индексам
      -- исходного массива: подбор мог дать меньше объектов, чем ожидалось,
      -- и сеяние падало с «в подборке нет такого объекта».
      perform set_selection_reaction(v_sel, si.object_id,
                 case si.position when 1 then 'liked' else 'disliked' end,
                 case si.position when 1 then 'нравится, хочу посмотреть'
                                  else 'слишком высокий этаж' end)
         from selection_items si where si.selection_id = v_sel;
      perform set_config('request.jwt.claims', '{}', true);
      perform app.selection_page((select token from selections where id = v_sel));

      perform set_config('request.jwt.claims',
        json_build_object('sub', (select auth_user_id from agents where id = v_bakyt),
                          'role', 'authenticated')::text, true);

      -- Отправленная и НЕ открытая: главное состояние этого экрана.
      select id into v_sel from create_selection(v_req, v_objs[1:1],
        'Ещё один вариант, появился сегодня');
      perform send_selection(v_sel);
    end if;
  end if;

  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- Айбек — руководитель агентства: иначе экран «У кого сколько» в разработке
-- нечем открыть, а он и есть главное, что просил руководитель.
do $$
declare v_admin uuid := (select id from agents where role = 'admin' limit 1);
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select auth_user_id from agents where id = v_admin),
                      'role', 'authenticated')::text, true);
  perform set_agent_role((select id from agents where full_name = 'Айбек'), 'head');
  perform set_config('request.jwt.claims', '{}', true);
end $$;
