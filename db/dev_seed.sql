-- db/dev_seed.sql — данные для разработки каталога. НЕ миграция и НЕ приёмка.
--
-- Нужен потому, что на трёх объектах сценария приёмки не видно ни фильтров,
-- ни сортировки, ни пустых состояний. Применяется ПОСЛЕ tests/seed.sql:
-- агентов и собственника берёт оттуда.
--
--   PGHOST=/tmp PGPORT=55432 PGUSER=postgres psql -d partner -f db/dev_seed.sql
--
-- Каждому объекту выдаётся мандат, иначе инвариант 1 не даст его опубликовать.
-- Это и есть проверка модели данными: в каталоге физически не может оказаться
-- объект без действующего договора.

do $$
declare
  v_agent   uuid := '00000000-0000-0000-0000-0000000000a1';  -- Айбек
  v_agent2  uuid := '00000000-0000-0000-0000-0000000000a2';  -- Бакыт
  v_owner   uuid := '00000000-0000-0000-0000-00000000c001';
  r         record;
  v_obj     uuid;
begin
  -- Собственников несколько. В первой версии все пятнадцать объектов
  -- принадлежали одному контакту, и кабинет собственника показывал
  -- восемнадцать квартир — экран, которого в жизни не бывает: так выглядит
  -- не собственник, а агентство. Разработчик смотрел на простыню и считал
  -- её нормой.
  insert into contacts (id, kind, name, owner_agent_id, roles, source) values
    ('00000000-0000-0000-0000-00000000c010', 'person', 'Сыдыкова Айнура',
     v_agent, '{owner,landlord}', 'рекомендация'),
    ('00000000-0000-0000-0000-00000000c011', 'person', 'Абдыраимов Темир',
     v_agent2, '{owner}', 'сайт'),
    ('00000000-0000-0000-0000-00000000c012', 'company', 'ОсОО «Элет-Инвест»',
     v_agent2, '{owner}', 'повторное обращение')
  on conflict (id) do nothing;

  -- Телефоны выдуманные: чужой номер в репозитории хранить незачем.
  insert into contact_phones (contact_id, phone, is_primary) values
    ('00000000-0000-0000-0000-00000000c010', '+996700555101', true),
    ('00000000-0000-0000-0000-00000000c011', '+996700555102', true),
    ('00000000-0000-0000-0000-00000000c012', '+996312555103', true)
  on conflict do nothing;

  for r in
    select * from (values
      -- вид,         сделка, адрес,                      зона,        комн, площадь, этаж, всего, цена,  валюта, дней_назад_подтверждён, агент, собственник
      ('flat',        'sale', 'Киевская 148, кв. 44',      'Центр',        1,  38.0,  5, 9,   62000,  'USD',  1, 1, 2),
      ('flat',        'sale', 'Горького 183, кв. 7',       'Юг',           2,  54.5,  2, 5,   71000,  'USD',  3, 2, 3),
      ('flat',        'sale', 'Исанова 105, кв. 61',       'Центр',        3,  88.0, 11, 12, 135000,  'USD',  0, 1, 2),
      ('flat',        'sale', 'Байтик Баатыра 41, кв. 18', 'Восток',       2,  61.0,  4, 9,   79000,  'USD', 12, 2, 3),
      ('flat',        'rent', 'Московская 217, кв. 9',     'Центр',        2,  52.0,  3, 6,     450,  'USD',  2, 1, 1),
      ('flat',        'rent', 'Ахунбаева 134, кв. 72',     'Юг',           1,  34.0,  8, 10,    280,  'USD',  5, 2, 2),
      ('flat',        'rent', 'Жукеева-Пудовкина 77, кв. 3','Запад',       3,  76.0,  1, 5,     620,  'USD', 21, 1, 3),
      ('house',       'sale', 'Чон-Арык, ул. Садовая 12',  'Юг',           5, 210.0,  1, 2,  185000,  'USD',  4, 1, 2),
      ('house',       'sale', 'Воено-Антоновка, уч. 8',    'Запад',        4, 160.0,  1, 1,   98000,  'USD',  9, 2, 3),
      ('townhouse',   'sale', 'Джал, кв-л Асанбай 4/2',    'Юг',           4, 142.0,  1, 3,  156000,  'USD',  2, 1, 2),
      ('land',        'sale', 'Ала-Арча, уч. 31',          'Запад',     null,  800.0, null, null, 42000, 'USD', 16, 1, 4),
      ('commercial',  'rent', 'Эркиндик 58, 1 этаж',       'Центр',     null,  120.0,  1, 7,   1800,  'USD',  1, 2, 4),
      ('commercial',  'sale', 'Тыныстанова 199, офис',     'Центр',     null,  210.0,  3, 8,  240000, 'USD',  7, 1, 4),
      ('room',        'rent', 'Орозбекова 44, комната',    'Центр',        1,  18.0,  2, 4,     150,  'USD', 34, 2, 1),
      -- Длинный адрес. В Бишкеке такие обычны: микрорайон, дом с дробью,
      -- квартира и ориентир. Нужен затем, что на коротких адресах вёрстка в
      -- ширину телефона выглядит целой при любых правилах переноса — проход
      -- walk-mobile это и показал: мутация «адрес не переносить» выжила,
      -- потому что самому длинному адресу в данных было двадцать семь букв.
      ('flat',        'sale', 'мкр. Джал-23, дом 12/4, кв. 118, ориентир школа №61', 'Юг', 3, 82.0, 6, 9, 92000, 'USD', 6, 1, 2),
      -- Подвисший объект ПЕРВОГО агента. Нужен затем, что иначе на его
      -- главной плитка «требуют внимания срочно» всегда ноль, и ни обход,
      -- ни показ возможность не видят: единственный срочный объект был у
      -- второго агента, то есть у коллеги. Два случая рядом — своё и
      -- чужое — показывают разницу, ради которой цифру и ограничили своим.
      ('flat',        'sale', 'Тоголок Молдо 17, кв. 12',  'Центр',        2,  58.0,  7, 9,   74000,  'USD', 31, 1, 2),
      ('garage',      'sale', 'Тунгуч, бокс 17',           'Север',     null,  24.0, null, null,  9000, 'USD', 11, 1, 4)
    ) as v(kind, deal_type, address, zone, rooms, area, floor, floors_total, price, currency, stale_days, agent_no, owner_no)
  loop
    -- Повторный запуск не плодит двойников.
    --
    -- Файл применяют не один раз: данные разработки сползают от самих обходов
    -- браузером, и их обновляют этим файлом. Без проверки каждый повтор
    -- заводил второй объект с тем же адресом и своим договором — пары
    -- одинаковых объявлений, которых в жизни не бывает. Второй цикл ниже
    -- защищён так с самого начала; этот был пропущен.
    continue when exists (select 1 from objects o where o.address = r.address);

    -- Разная свежесть подтверждения задаётся ПРИ ВСТАВКЕ. Правкой её задать
    -- нельзя: инвариант 5 не разрешает двигать actual_at назад, и первая
    -- версия этого файла молча получила «подтверждено сегодня» у всех
    -- объектов. Инвариант сработал, данные были неправильные.
    insert into objects (kind, deal_type, address, zone, rooms, area, floor,
                         floors_total, price, currency, description,
                         actual_at, created_by_agent_id)
    values (r.kind::object_kind, r.deal_type::deal_type, r.address, r.zone,
            r.rooms, r.area, r.floor, r.floors_total, r.price, r.currency,
            'Объект для разработки каталога. Описание заполняется агентом.',
            now() - (r.stale_days || ' days')::interval,
            case r.agent_no when 1 then v_agent else v_agent2 end)
    returning id into v_obj;

    insert into object_ownerships (object_id, contact_id, role, share)
    values (v_obj,
            case r.owner_no
              when 1 then v_owner
              when 2 then '00000000-0000-0000-0000-00000000c010'::uuid
              when 3 then '00000000-0000-0000-0000-00000000c011'::uuid
              else        '00000000-0000-0000-0000-00000000c012'::uuid
            end,
            'owner', 1);

    -- Инвариант 1: без активного мандата публикация невозможна.
    -- Договор начался два месяца назад: в данных разработки есть показы
    -- прошедших дней, а показ до начала договора инвариант 26 не пропустит —
    -- и правильно сделает.
    insert into mandates (object_id, kind, valid_from, start_price,
                          listing_agent_id, contract_confirmed, status)
    values (v_obj, 'non_exclusive', current_date - 60, r.price,
            case r.agent_no when 1 then v_agent else v_agent2 end, true, 'active');

    -- Публикация не трогает actual_at: цена и фото не менялись.
    update objects set publication_state = 'published' where id = v_obj;
  end loop;
end $$;

-- Один черновик без мандата: в каталоге его быть не должно.
insert into objects (kind, deal_type, address, zone, rooms, area, floor, price, created_by_agent_id)
select 'flat', 'sale', 'Черновик без мандата', 'Центр', 2, 50.0, 1, 50000,
       '00000000-0000-0000-0000-0000000000a1'
 where not exists (select 1 from objects where address = 'Черновик без мандата');

select count(*) as объектов_в_каталоге from public_catalog_v;

-- ---------------------------------------------------------------------------
-- Работа по одному объекту, чтобы отчёт собственнику было чем наполнить
-- ---------------------------------------------------------------------------
-- Берём объект приёмки obj1 (Чүй 120): по нему уже есть мандат Айбека и
-- собственник. Добавляем размещение, подбор и состоявшийся показ.

do $$
declare
  v_obj   uuid := '00000000-0000-0000-0000-0000000b0001';
  v_req   uuid := '00000000-0000-0000-0000-00000000e001';
  v_aibek uuid := '00000000-0000-0000-0000-0000000000a1';
  v_bakyt uuid := '00000000-0000-0000-0000-0000000000a2';
  v_owner uuid := '00000000-0000-0000-0000-00000000c001';
  v_day   date := (now() at time zone 'Asia/Bishkek')::date;
  v_match uuid;
  v_show  uuid;
begin
  -- Повторный запуск на базе, по которой уже поработали, не должен падать.
  --
  -- Этот блок добавляет к объекту приёмки размещение, подбор и показ, и для
  -- размещения нужен действующий договор. А договор кончается: закрытая
  -- сделка его закрывает. Файл применяют не один раз — данные разработки
  -- сползают от обходов браузером, и обновляют их именно им, — и повторный
  -- запуск падал с «объект не может быть выгружен в канал без активного
  -- мандата». Инвариант 1 прав; неправ был файл, молча считавший базу чистой.
  if not exists (select 1 from mandates m
                  where m.object_id = v_obj and m.status = 'active') then
    raise notice 'у объекта приёмки нет действующего договора — работа по нему пропущена; для полных данных пересоберите базу: db/rebuild.sh';
    return;
  end if;

  -- Каналы — это намерение отдавать объект на площадку (инвариант 28).
  -- «Размещено» здесь больше не пишется: площадка нам этого не сообщает.
  insert into publication_channels (object_id, channel, enabled)
  values (v_obj, 'lalafo',   true),
         (v_obj, 'house_kg', true),
         (v_obj, 'site',     true)
  on conflict (object_id, channel) do nothing;

  -- Остальные опубликованные объекты тоже отдаём на площадки: на одном
  -- объекте не видно ни фида, ни экрана каналов.
  insert into publication_channels (object_id, channel, enabled)
  select o.id, c, true
    from objects o
    cross join (values ('lalafo'::publication_channel), ('house_kg'::publication_channel)) as t(c)
   where o.publication_state = 'published'
  on conflict (object_id, channel) do nothing;

  insert into matches (object_id, requirement_id, closing_agent_id, created_by_agent_id)
  values (v_obj, v_req, v_bakyt, v_bakyt)
  on conflict (object_id, requirement_id) do nothing
  returning id into v_match;

  if v_match is null then
    select id into v_match from matches
     where object_id = v_obj and requirement_id = v_req;
  end if;

  -- Время круглое и по Бишкеку. От now() получался бы показ в 01:21 ночи —
  -- на экране это читается как поломка, а не как данные.
  insert into showings (match_id, agent_id, scheduled_at, done_at, status,
                        outcome, client_reaction, created_by_agent_id)
  values (v_match, v_bakyt, (v_day - 5 + time '16:00') at time zone 'Asia/Bishkek', (v_day - 5 + time '17:00') at time zone 'Asia/Bishkek',
          'done', 'wants_bargain', 'нравится, но просит минус 3000', v_bakyt),
         (v_match, v_bakyt, (v_day - 2 + time '13:00') at time zone 'Asia/Bishkek', (v_day - 2 + time '14:00') at time zone 'Asia/Bishkek',
          'done', 'thinking', 'взяли паузу до выходных', v_bakyt),
         (v_match, v_bakyt, (v_day + 2 + time '18:00') at time zone 'Asia/Bishkek', null,
          'scheduled', null, null, v_bakyt);

  -- Ссылка на отчёт. Вставляется напрямую, а не через issue_owner_access:
  -- у сеяния нет входа, а функция требует текущего агента. Триггер
  -- инварианта 10 при этом работает: выдать может только listing-агент.
  insert into owner_access (object_id, contact_id, token, issued_by_agent_id, expires_at)
  values (v_obj, v_owner, 'aaaaaaaabbbbccccddddeeeeffff0001', v_aibek,
          now() + interval '90 days')
  on conflict (token) do nothing;
end $$;

select 'отчёт собственнику: /report/aaaaaaaabbbbccccddddeeeeffff0001' as ссылка;

-- ---------------------------------------------------------------------------
-- Фотографии для разработки
-- ---------------------------------------------------------------------------
-- Записи делает scripts/make-dev-photos.mjs: он же рисует сами файлы, потому
-- что ключ в базе и файл в хранилище должны появиться вместе. Здесь только
-- напоминание, что без него карточки будут без фотографий.

select 'фотографии: node web/scripts/make-dev-photos.mjs' as дальше;

-- ---------------------------------------------------------------------------
-- Второе агентство (инвариант 37)
-- ---------------------------------------------------------------------------
-- Без него мультилистинг в кабинете не видно: все объекты свои, фильтр
-- источника показывает два значения из трёх, а «чужой объект с подписанным
-- договором» — главный ответ платформы на вопрос «получу ли я комиссию» —
-- на экране не встречается ни разу. Экран, который разработчик видел только
-- в одном агентстве, в первый же день мультилистинга ведёт себя неожиданно.

do $$
declare
  v_alfa_agency uuid := '00000000-0000-0000-0000-00000000aa02';
  v_nurlan uuid := '00000000-0000-0000-0000-0000000000f1';
  v_owner  uuid;
  r        record;
  v_obj    uuid;
begin
  insert into agencies (id, name) values (v_alfa_agency, 'Альфа Недвижимость')
  on conflict (id) do nothing;

  insert into agents (id, email, phone, auth_user_id, full_name, role, status,
                      agency_id, directions)
  values (v_nurlan, 'nurlan@alfa.kg', '+996700900011',
          '00000000-0000-0000-0000-0000000000e1', 'Нурлан Абдиев',
          'agent', 'approved', v_alfa_agency, '{sale,rent}')
  on conflict (id) do nothing;

  -- Собственники Альфы — её контакты. Айбек их имён не увидит: инвариант 4
  -- границу агентства не отменяет, а усиливает.
  insert into contacts (id, kind, name, owner_agent_id, roles, source) values
    ('00000000-0000-0000-0000-00000000c0a1', 'person', 'Орунбаев Данияр',
     v_nurlan, '{owner}', 'своя база Альфы'),
    ('00000000-0000-0000-0000-00000000c0a2', 'person', 'Мамытова Венера',
     v_nurlan, '{owner,landlord}', 'своя база Альфы')
  on conflict (id) do nothing;

  insert into contact_phones (contact_id, phone, is_primary) values
    ('00000000-0000-0000-0000-00000000c0a1', '+996700555201', true),
    ('00000000-0000-0000-0000-00000000c0a2', '+996700555202', true)
  on conflict do nothing;

  for r in
    select * from (values
      -- адрес,                   тип,    сделка, район,   комн, площадь, этаж, этажей, цена,  договор,          подписан, публиковать, собственник
      ('Жибек Жолу 100, кв. 3',  'flat', 'sale', 'Центр',  3, 72.0,  4, 9, 99000,  'exclusive',     true,  true,  '00000000-0000-0000-0000-00000000c0a1'),
      ('Ибраимова 42, кв. 18',   'flat', 'sale', 'Центр',  2, 56.0,  7, 12, 78000, 'non_exclusive', true,  true,  '00000000-0000-0000-0000-00000000c0a2'),
      ('Турусбекова 9, кв. 4',   'flat', 'rent', 'Запад',  1, 34.0,  2, 5, 320,    'non_exclusive', false, true,  '00000000-0000-0000-0000-00000000c0a2'),
      -- Объект Альфы вообще без договора: в подбор он не идёт, и это видно.
      ('Панфилова 170, кв. 11',  'flat', 'sale', 'Юг',     2, 61.0,  3, 9, 82000,  null,            null,  false, '00000000-0000-0000-0000-00000000c0a1')
    ) as t(address, kind, deal, zone, rooms, area, floor, floors, price, mkind, confirmed, publish, owner)
  loop
    select id into v_obj from objects where address = r.address;
    if v_obj is null then
      insert into objects (kind, deal_type, address, zone, rooms, area, floor,
                           floors_total, price, currency, description,
                           created_by_agent_id, actual_at)
      values (r.kind::object_kind, r.deal::deal_type, r.address, r.zone,
              r.rooms::smallint, r.area, r.floor::smallint, r.floors::smallint,
              r.price, 'USD', 'Объект другого агентства: так выглядит мультилистинг.',
              v_nurlan, now() - interval '3 days')
      returning id into v_obj;

      insert into object_ownerships (object_id, contact_id, role, share)
      values (v_obj, r.owner::uuid, 'owner', 1);

      if r.mkind is not null then
        insert into mandates (object_id, kind, valid_from, valid_to, start_price,
                              listing_agent_id, contract_confirmed, status)
        values (v_obj, r.mkind::mandate_kind, current_date - 20, current_date + 70,
                r.price * 1.05, v_nurlan, r.confirmed, 'active');
      end if;

      if r.publish then
        update objects set publication_state = 'published', published_at = now()
         where id = v_obj;
      end if;
    end if;
  end loop;
end $$;

select 'второе агентство: Альфа Недвижимость, 4 объекта' as мультилистинг;

-- ---------------------------------------------------------------------------
-- Аттестация ТПП (инвариант 38)
-- ---------------------------------------------------------------------------
-- Три состояния из четырёх: подтверждённое, заявленное и истёкшее. Без них
-- экран виден только в одном положении, а разница между «заявлен» и
-- «подтверждён» — это весь смысл поля.

do $$
declare
  v_admin uuid := (select id from agents where full_name = 'Админ');
begin
  update agents set certificate_no = 'ТПП-КР-0241',
                    certificate_issued_on = current_date - 400,
                    certificate_valid_to  = current_date + 1425
   where full_name = 'Айбек';
  update agents set certificate_confirmed_at = now() - interval '380 days',
                    certificate_confirmed_by = v_admin
   where full_name = 'Айбек';

  -- Заявлен и ждёт сверки: главное состояние очереди администратора.
  update agents set certificate_no = 'ТПП-КР-0588',
                    certificate_issued_on = current_date - 20,
                    certificate_valid_to  = current_date + 1805
   where full_name = 'Бакыт';

  -- Истёк: агент был в реестре, и это не то же самое, что «не проходил».
  update agents set certificate_no = 'ТПП-КР-0107',
                    certificate_issued_on = current_date - 1900,
                    certificate_valid_to  = current_date - 75
   where full_name = 'Чынгыз';
  update agents set certificate_confirmed_at = now() - interval '1890 days',
                    certificate_confirmed_by = v_admin
   where full_name = 'Чынгыз';

  -- Агент чужого агентства тоже аттестован: по чужому объекту это и есть
  -- ответ на вопрос «с кем я имею дело».
  update agents set certificate_no = 'ТПП-КР-0903',
                    certificate_issued_on = current_date - 200,
                    certificate_valid_to  = current_date + 1625
   where full_name = 'Нурлан Абдиев';
  update agents set certificate_confirmed_at = now() - interval '190 days',
                    certificate_confirmed_by = v_admin
   where full_name = 'Нурлан Абдиев';
end $$;

select 'аттестация: подтверждена, заявлена, истекла' as тпп;
