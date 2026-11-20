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
  for r in
    select * from (values
      -- вид,         сделка, адрес,                      зона,        комн, площадь, этаж, всего, цена,  валюта, дней_назад_подтверждён, агент
      ('flat',        'sale', 'Киевская 148, кв. 44',      'Центр',        1,  38.0,  5, 9,   62000,  'USD',  1, 1),
      ('flat',        'sale', 'Горького 183, кв. 7',       'Юг',           2,  54.5,  2, 5,   71000,  'USD',  3, 2),
      ('flat',        'sale', 'Исанова 105, кв. 61',       'Центр',        3,  88.0, 11, 12, 135000,  'USD',  0, 1),
      ('flat',        'sale', 'Байтик Баатыра 41, кв. 18', 'Восток',       2,  61.0,  4, 9,   79000,  'USD', 12, 2),
      ('flat',        'rent', 'Московская 217, кв. 9',     'Центр',        2,  52.0,  3, 6,     450,  'USD',  2, 1),
      ('flat',        'rent', 'Ахунбаева 134, кв. 72',     'Юг',           1,  34.0,  8, 10,    280,  'USD',  5, 2),
      ('flat',        'rent', 'Жукеева-Пудовкина 77, кв. 3','Запад',       3,  76.0,  1, 5,     620,  'USD', 21, 1),
      ('house',       'sale', 'Чон-Арык, ул. Садовая 12',  'Юг',           5, 210.0,  1, 2,  185000,  'USD',  4, 1),
      ('house',       'sale', 'Воено-Антоновка, уч. 8',    'Запад',        4, 160.0,  1, 1,   98000,  'USD',  9, 2),
      ('townhouse',   'sale', 'Джал, кв-л Асанбай 4/2',    'Юг',           4, 142.0,  1, 3,  156000,  'USD',  2, 1),
      ('land',        'sale', 'Ала-Арча, уч. 31',          'Запад',     null,  800.0, null, null, 42000, 'USD', 16, 1),
      ('commercial',  'rent', 'Эркиндик 58, 1 этаж',       'Центр',     null,  120.0,  1, 7,   1800,  'USD',  1, 2),
      ('commercial',  'sale', 'Тыныстанова 199, офис',     'Центр',     null,  210.0,  3, 8,  240000, 'USD',  7, 1),
      ('room',        'rent', 'Орозбекова 44, комната',    'Центр',        1,  18.0,  2, 4,     150,  'USD', 34, 2),
      ('garage',      'sale', 'Тунгуч, бокс 17',           'Север',     null,  24.0, null, null,  9000, 'USD', 11, 1)
    ) as v(kind, deal_type, address, zone, rooms, area, floor, floors_total, price, currency, stale_days, agent_no)
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
    values (v_obj, v_owner, 'owner', 1);

    -- Инвариант 1: без активного мандата публикация невозможна.
    insert into mandates (object_id, kind, start_price, listing_agent_id, contract_confirmed, status)
    values (v_obj, 'non_exclusive', r.price,
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
