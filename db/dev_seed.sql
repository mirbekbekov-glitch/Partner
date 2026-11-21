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
      ('garage',      'sale', 'Тунгуч, бокс 17',           'Север',     null,  24.0, null, null,  9000, 'USD', 11, 1, 4)
    ) as v(kind, deal_type, address, zone, rooms, area, floor, floors_total, price, currency, stale_days, agent_no, owner_no)
  loop
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
values ('flat', 'sale', 'Черновик без мандата', 'Центр', 2, 50.0, 1, 50000,
        '00000000-0000-0000-0000-0000000000a1');

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
