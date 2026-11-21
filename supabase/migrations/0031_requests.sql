-- 0031_requests.sql
-- Заявки покупателей и арендаторов.
--
-- Человек не нашёл объект в каталоге и говорит, что ищет. Ценность вся в
-- скорости первого ответа: заявка, пролежавшая час, обычно уже не нужна.
--
-- ГЛАВНОЕ РЕШЕНИЕ: заявки живут ОТДЕЛЬНО от объявлений. На прежнем сайте их
-- держали в одной таблице с объявлениями, отличая значением поля «тип
-- сделки». К ноябрю 2026 в выгрузке каталога было 280 строк, из них 278 —
-- заявки и две настоящих объявления: каталог показывал «1 объект», выгрузка
-- весила 343 КБ почти целиком из запросов. Поэтому здесь своя таблица, своё
-- представление и своя выдача, а в public_catalog_v заявке попасть неоткуда
-- — она не объект и не ссылается на objects.
--
-- Второе решение: направление сделки — ПОЛЕ, а не догадка. Раньше его
-- выводили из текста заголовка регулярным выражением («Куплю…» → продажа,
-- «в цене есть „мес“» → аренда). Такое угадывание ошибается молча, и агент
-- получает заявку не своего направления. Здесь это колонка, которую
-- заполняет форма; не заполнена — значит не указано, и такую заявку видят
-- агенты обоих направлений.
--
-- Третье: район выбирается из списка. Свободным текстом на прежнем сайте
-- вышло 271 разное значение на 280 заявок — туда писали адреса и ориентиры
-- вроде «рядом с Ошским». Фильтровать по такому полю невозможно. Список
-- плюс отдельное поле «свой вариант»: когда вариант повторяется, админ
-- заводит его в справочник.

-- ---------------------------------------------------------------------------
-- Справочник районов
-- ---------------------------------------------------------------------------

create table districts (
  id         uuid primary key default gen_random_uuid(),
  city       text not null default 'Бишкек',
  name       text not null check (length(btrim(name)) between 2 and 80),
  -- Нормализованное имя не даёт завести «Асанбай» и «асанбай » дважды.
  name_normalized text generated always as (app.normalize_name(name)) stored,
  sort       smallint not null default 100,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index districts_unique_idx on districts (city, name_normalized);

comment on table districts is
  'Районы города для фильтров и заявок. Список, а не свободный текст: '
  'на прежнем сайте свободное поле дало 271 написание на 280 заявок.';

insert into districts (name, sort) values
  ('Центр', 10), ('Асанбай', 20), ('Джал', 30), ('Восток-5', 40),
  ('Аламедин-1', 50), ('Тунгуч', 60), ('Политех', 70), ('Юг-2', 80),
  ('Кок-Жар', 90), ('Арча-Бешик', 100), ('Орто-Сай', 110), ('Мадина', 120),
  ('Шлагбаум', 130), ('Рабочий городок', 140), ('Кызыл-Аскер', 150),
  ('Ак-Орго', 160), ('Маевка', 170), ('Чон-Арык', 180);

-- ---------------------------------------------------------------------------
-- Заявка
-- ---------------------------------------------------------------------------

create type request_deal as enum ('buy', 'rent');

create type request_status as enum (
  'new',      -- поступила, никто не взял
  'in_work',  -- агент взял в работу
  'closed',   -- закрыта с причиной
  'expired'   -- ушла в архив сама: лежала без движения
);

-- Закрытие обязано называть причину. На прежнем сайте у заявки был статус,
-- но не было причины закрытия — и старые заявки копились в ленте, мешая
-- видеть свежие, потому что никто не понимал, можно ли их убирать.
create type request_close_reason as enum (
  'deal',         -- довели до сделки
  'found_self',   -- нашёл сам
  'changed_mind', -- передумал
  'no_answer',    -- не дозвонились
  'spam',
  'other'
);

create table requests (
  id            uuid primary key default gen_random_uuid(),

  -- Что ищет. Направление — поле, а не угадывание по заголовку.
  deal          request_deal,
  housing_type  object_kind,
  rooms         smallint check (rooms between 1 and 20),
  district_id   uuid references districts (id) on delete set null,
  -- Своего варианта в справочнике нет — пишем сюда, не портя список.
  district_other text check (district_other is null or length(btrim(district_other)) between 2 and 120),
  budget        numeric(14,2) check (budget is null or budget > 0),
  budget_currency char(3) not null default 'USD' check (budget_currency in ('USD', 'KGS')),
  wishes        text check (wishes is null or length(wishes) <= 2000),

  -- Контакт.
  name          text check (name is null or length(btrim(name)) between 1 and 120),
  phone         text not null,
  phone_normalized text generated always as (app.normalize_phone(phone)) stored,
  -- Согласие показать контакт агентам даёт ЧЕЛОВЕК, а не агент. Без него
  -- телефон не покажется никому, кроме админа: см. request_feed_v.
  public_consent boolean not null default false,

  -- Жизненный цикл.
  status        request_status not null default 'new',
  agent_id      uuid references agents (id) on delete set null,
  taken_at      timestamptz,
  -- Когда агент впервые отчитался о работе. Срок первого ответа считается
  -- от created_at до этой отметки.
  first_response_at timestamptz,
  closed_reason request_close_reason,
  closed_at     timestamptz,

  -- Во что превратилась заявка, когда агент взял её в работу.
  contact_id     uuid references contacts (id) on delete set null,
  requirement_id uuid references requirements (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Взята — значит есть кто и когда.
  constraint requests_taken_consistent check (
    (status in ('new', 'expired') and agent_id is null and taken_at is null)
    or (status in ('in_work', 'closed') and agent_id is not null and taken_at is not null)
  ),
  -- Закрыта — значит названа причина.
  constraint requests_closed_consistent check (
    (status = 'closed') = (closed_reason is not null and closed_at is not null)
  )
);

comment on table requests is
  'Заявки «что я ищу» с публичного сайта. Отдельно от объявлений: смешение '
  'их в одной таблице на прежнем сайте превратило каталог из 280 строк в 278 '
  'заявок и 2 объявления. Пишутся только через app.submit_request().';

create index requests_open_idx    on requests (status, created_at desc);
create index requests_agent_idx   on requests (agent_id, created_at desc);
create index requests_phone_idx   on requests (phone_normalized, created_at desc);

create trigger requests_touch before update on requests
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Направление работы агента
-- ---------------------------------------------------------------------------
-- Продажник не должен разбирать ленту аренды и наоборот. По умолчанию «оба»:
-- иначе существующие агенты разом перестали бы видеть заявки.

create type agent_focus as enum ('sale', 'rent', 'both');

alter table agents add column focus agent_focus not null default 'both';

comment on column agents.focus is
  'Какие заявки показывать в ленте. Заявку без направления видят все: '
  'лучше лишний показ, чем потерянный клиент.';

-- ---------------------------------------------------------------------------
-- Доступ
-- ---------------------------------------------------------------------------
-- Таблица закрыта наглухо: ни анониму, ни агенту. Единственная дверь на
-- чтение — представление ниже, и оно же решает, что показать. Так сделано
-- потому, что скрыть КОЛОНКУ у части строк политиками RLS нельзя: политика
-- отдаёт строку целиком или не отдаёт вовсе. Если бы агент мог читать
-- таблицу напрямую через PostgREST, он получил бы телефон чужой заявки в
-- обход всех масок.

alter table requests  enable row level security;
alter table districts enable row level security;

revoke all on requests from anon, authenticated;
grant select on districts to anon, authenticated;

create policy districts_read on districts for select using (true);

-- Одобренный агент видит СТРОКУ заявки — её параметры. Этого достаточно,
-- чтобы решить, брать ли её, и ничего не раскрывает о человеке.
create policy requests_read on requests for select
  using (app.current_agent_id() is not null);

-- А вот КОЛОНКИ с личными данными не выданы никому и никогда: ни name, ни
-- phone, ни phone_normalized, ни wishes в этом списке нет. Политика RLS
-- отдаёт строку целиком или не отдаёт вовсе — спрятать колонку у части
-- строк она не умеет. Поэтому границу держат колоночные права, а показывает
-- личные данные одна функция app.request_contact() ниже.
grant select (
  id, deal, housing_type, rooms, district_id, district_other,
  budget, budget_currency, public_consent, status, agent_id, taken_at,
  first_response_at, closed_reason, closed_at, contact_id, requirement_id,
  created_at, updated_at
) on requests to authenticated;

-- Личные данные заявки отдаёт одна функция, и только она. Она объявлена
-- security definer, поэтому читает закрытые колонки; решение «показать или
-- нет» принимается здесь, в одном месте, которое можно прочитать целиком.
create function app.request_contact(p_id uuid)
  returns table (name text, phone text, wishes text)
  language sql stable security definer set search_path = public, auth, pg_temp as $$
  select
    case when ok then r.name   end,
    case when ok then r.phone  end,
    case when ok then r.wishes end
  from requests r
  cross join lateral (
    select
      -- Админ видит контакт всегда: ему разбирать спор о перехвате клиента.
      app.is_admin()
      -- Остальным — только своё и только с согласия человека. Согласие даёт
      -- человек, а не агент: без public_consent телефон не увидит никто.
      -- Заявку взял другой — контакт закрывается и для прежних зрителей:
      -- это защита и от перехвата клиента, и от того, чтобы одному
      -- человеку позвонили пятеро.
      or (r.public_consent
          and app.current_agent_id() is not null
          and (r.agent_id is null or r.agent_id = app.current_agent_id()))
      as ok
  ) g
  where r.id = p_id
$$;

comment on function app.request_contact is
  'Имя, телефон и пожелания заявки — или NULL, если смотрящему их не '
  'положено. Единственная дверь к личным данным: колонки name, phone и '
  'wishes не выданы роли authenticated вовсе.';

-- ---------------------------------------------------------------------------
-- Лента заявок
-- ---------------------------------------------------------------------------

create view request_feed_v
  with (security_invoker = true) as
select
  r.id,
  r.deal,
  r.housing_type,
  r.rooms,
  d.name as district,
  r.district_other,
  r.budget,
  r.budget_currency,
  r.status,
  r.created_at,
  r.taken_at,
  r.first_response_at,
  r.closed_reason,
  r.closed_at,
  r.contact_id,
  r.requirement_id,
  r.agent_id,
  ag.full_name as agent_name,

  -- Состояние заявки ГЛАЗАМИ смотрящего, а не вообще.
  case
    when r.agent_id is null                        then 'available'
    when r.agent_id = app.current_agent_id()       then 'mine'
    else                                                'other'
  end as mine_state,

  -- Контактные поля. Открыты только тому, кто ведёт заявку, и админу — и
  -- только если человек дал согласие. Когда заявку взял другой агент, здесь
  -- NULL: это защита и от перехвата клиента, и от того, чтобы одному
  -- человеку позвонили пятеро.
  rc.name,
  rc.phone,
  rc.wishes,
  r.public_consent,

  -- Срок первого ответа. Норматив — 60 минут от появления заявки.
  (r.first_response_at is null
     and r.status in ('new', 'in_work')
     and now() - r.created_at > interval '60 minutes') as overdue,
  extract(epoch from coalesce(r.first_response_at, now()) - r.created_at)::int / 60 as response_minutes
from requests r
left join districts d on d.id = r.district_id
left join agents    ag on ag.id = r.agent_id
left join lateral app.request_contact(r.id) rc on true
where app.current_agent_id() is not null
  -- Направление: продажник видит покупку, арендник — аренду, заявку без
  -- направления видят оба. Админ видит всё.
  and (
    app.is_admin()
    or r.deal is null
    or (select a.focus from agents a where a.id = app.current_agent_id()) = 'both'
    or (r.deal = 'buy'  and (select a.focus from agents a where a.id = app.current_agent_id()) = 'sale')
    or (r.deal = 'rent' and (select a.focus from agents a where a.id = app.current_agent_id()) = 'rent')
  );

comment on view request_feed_v is
  'Лента заявок для агента: параметры всех заявок своего направления, '
  'личные данные — только по праву. Фильтр по направлению здесь удобство, '
  'а не защита: защита — колоночные права и app.request_contact().';

grant select on request_feed_v to authenticated;
revoke all   on request_feed_v from anon;

-- ---------------------------------------------------------------------------
-- Приём заявки от неизвестного
-- ---------------------------------------------------------------------------
-- Та же модель, что у submit_lead (0028): анониму не выдана таблица, выдана
-- одна функция. Всё проверяется здесь, а не в форме: форму обойти
-- тривиально, запрос уходит прямо в PostgREST.

create function app.submit_request(
  p_phone          text,
  p_name           text    default null,
  p_deal           text    default null,
  p_housing_type   text    default null,
  p_rooms          int     default null,
  p_district       text    default null,
  p_budget         numeric default null,
  p_budget_currency text   default 'USD',
  p_wishes         text    default null,
  p_consent        boolean default false
) returns uuid
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_phone text := btrim(coalesce(p_phone, ''));
  v_norm  text := app.normalize_phone(v_phone);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_wish  text := nullif(btrim(coalesce(p_wishes, '')), '');
  v_district_id uuid;
  v_district_other text;
  v_deal request_deal;
  v_kind object_kind;
  v_id uuid;
begin
  -- Телефон — единственное обязательное поле. Чем меньше обязательных
  -- полей, тем больше заявок доходит; всё остальное агент спросит сам.
  if v_norm is null or length(v_norm) < 9 then
    raise exception 'BAD_PHONE: проверьте номер телефона';
  end if;
  if v_name is not null and length(v_name) > 120 then
    raise exception 'BAD_INPUT: имя слишком длинное';
  end if;
  if v_wish is not null and length(v_wish) > 2000 then
    raise exception 'BAD_INPUT: сообщение слишком длинное';
  end if;

  -- Направление и тип приводим к перечислению. Чужое значение не роняет
  -- заявку, а просто остаётся незаполненным: потерять заявку из-за кривого
  -- параметра хуже, чем принять её без направления.
  begin v_deal := p_deal::request_deal; exception when others then v_deal := null; end;
  begin v_kind := p_housing_type::object_kind; exception when others then v_kind := null; end;

  -- Район: сначала ищем в справочнике, иначе кладём как свой вариант.
  if nullif(btrim(coalesce(p_district, '')), '') is not null then
    select id into v_district_id
      from districts
     where active and name_normalized = app.normalize_name(p_district)
     limit 1;
    if v_district_id is null then
      v_district_other := left(btrim(p_district), 120);
    end if;
  end if;

  -- Склейка повторов. Человек отправил форму трижды — заявка одна. На
  -- прежнем сайте этого не было, и в ленте лежали тройники.
  select id into v_id
    from requests
   where phone_normalized = v_norm
     and created_at > now() - interval '24 hours'
     and status in ('new', 'in_work')
   order by created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Частота: не больше пяти заявок с одного номера в сутки.
  if (select count(*) from requests
       where phone_normalized = v_norm
         and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'TOO_MANY: слишком много заявок с этого номера';
  end if;

  insert into requests (
    deal, housing_type, rooms, district_id, district_other,
    budget, budget_currency, wishes, name, phone, public_consent
  ) values (
    v_deal, v_kind,
    case when p_rooms between 1 and 20 then p_rooms::smallint end,
    v_district_id, v_district_other,
    case when p_budget > 0 then p_budget end,
    case when upper(coalesce(p_budget_currency, 'USD')) in ('USD', 'KGS')
         then upper(p_budget_currency) else 'USD' end,
    v_wish, v_name, v_phone, coalesce(p_consent, false)
  ) returning id into v_id;

  return v_id;
end;
$$;

comment on function app.submit_request is
  'Приём заявки от неизвестного. Обязателен только телефон. Повтор того же '
  'номера за сутки возвращает прежнюю заявку, а не создаёт вторую.';

-- ---------------------------------------------------------------------------
-- Работа с заявкой
-- ---------------------------------------------------------------------------

create function app.take_request(p_id uuid) returns void
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_agent uuid := app.require_agent();
begin
  update requests
     set status = 'in_work', agent_id = v_agent, taken_at = now()
   where id = p_id and status = 'new' and agent_id is null;

  if not found then
    -- Гонка двух агентов за одну заявку: проигравший должен понять, что
    -- произошло, а не увидеть «сохранено» и позвонить клиенту следом.
    raise exception 'TAKEN: заявку уже взяли или она закрыта';
  end if;
end;
$$;

create function app.release_request(p_id uuid) returns void
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_agent uuid := app.require_agent();
begin
  update requests
     set status = 'new', agent_id = null, taken_at = null
   where id = p_id and status = 'in_work'
     and (agent_id = v_agent or app.is_admin());
  if not found then
    raise exception 'DENIED: вернуть в ленту можно только свою заявку в работе';
  end if;
end;
$$;

create function app.close_request(p_id uuid, p_reason text) returns void
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_reason request_close_reason;
begin
  begin v_reason := p_reason::request_close_reason;
  exception when others then
    raise exception 'BAD_INPUT: неизвестная причина закрытия';
  end;

  update requests
     set status = 'closed', closed_reason = v_reason, closed_at = now()
   where id = p_id and status = 'in_work'
     and (agent_id = v_agent or app.is_admin());
  if not found then
    raise exception 'DENIED: закрыть можно только свою заявку в работе';
  end if;
end;
$$;

-- Отметка первого ответа. Ставится, когда агент отчитался о работе по
-- заявке: записал результат звонка, показа или задачи. Это и есть счётчик
-- скорости, который на прежнем сайте работал и который стоит сохранить.
create function app.answer_request(p_id uuid, p_note text) returns void
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_contact uuid;
begin
  if v_note is null then
    -- Пустой результат отметкой не считается: иначе счётчик закрывался бы
    -- нажатием кнопки, а не разговором с человеком.
    raise exception 'BAD_INPUT: напишите, чем закончился разговор';
  end if;

  select contact_id into v_contact from requests
   where id = p_id and status = 'in_work' and (agent_id = v_agent or app.is_admin());
  if not found then
    raise exception 'DENIED: отметить можно только свою заявку в работе';
  end if;

  update requests
     set first_response_at = coalesce(first_response_at, now())
   where id = p_id;

  -- Запись остаётся в истории клиента, если он уже заведён.
  if v_contact is not null then
    insert into activities (kind, entity_type, entity_id, agent_id, body, done, done_at)
    values ('call', 'contact', v_contact, v_agent, v_note, true, now());
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Превращение заявки в клиента
-- ---------------------------------------------------------------------------
-- Здесь заявка из записи в ленте становится работой: появляется контакт и
-- потребность, обе ссылаются на заявку. Отдельным шагом, а не при приёме с
-- сайта: иначе спам шёл бы прямо в ядро CRM, где живут настоящие клиенты.

create function app.convert_request(p_id uuid) returns uuid
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_agent uuid := app.require_agent();
  r requests%rowtype;
  v_contact uuid;
  v_req uuid;
begin
  select * into r from requests
   where id = p_id and status = 'in_work' and (agent_id = v_agent or app.is_admin());
  if not found then
    raise exception 'DENIED: превратить в клиента можно только свою заявку в работе';
  end if;
  if r.contact_id is not null then
    return r.contact_id;  -- уже превращена, повтор безвреден
  end if;

  insert into contacts (name, kind, owner_agent_id)
  values (coalesce(r.name, 'Заявка ' || to_char(r.created_at, 'DD.MM HH24:MI')),
          'person', r.agent_id)
  returning id into v_contact;

  insert into requirements (contact_id, deal_type, agent_id, requirements_text,
                            budget_max, zones, rooms)
  values (
    v_contact,
    case when r.deal = 'rent' then 'rent'::deal_type else 'sale'::deal_type end,
    r.agent_id,
    r.wishes,
    r.budget,
    case when coalesce((select name from districts where id = r.district_id), r.district_other) is null
         then '{}'::text[]
         else array[coalesce((select name from districts where id = r.district_id), r.district_other)]
    end,
    case when r.rooms is null then '{}'::smallint[] else array[r.rooms] end
  )
  returning id into v_req;

  update requests set contact_id = v_contact, requirement_id = v_req where id = p_id;
  return v_contact;
end;
$$;

-- ---------------------------------------------------------------------------
-- Срок жизни
-- ---------------------------------------------------------------------------
-- Заявка без движения уходит в архив сама. На прежнем сайте этого не было,
-- и свежие заявки тонули среди прошлогодних.

create function app.expire_requests(p_days int default 30) returns int
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare v_count int;
begin
  update requests
     set status = 'expired'
   where status = 'new'
     and created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Обёртки для PostgREST
-- ---------------------------------------------------------------------------
-- Схема app наружу не видна: PostgREST отдаёт только public. Обёртки
-- объявлены security definer там, где их зовёт аноним: у него нет права
-- usage на схему app.

create function public.submit_request(
  p_phone text, p_name text default null, p_deal text default null,
  p_housing_type text default null, p_rooms int default null,
  p_district text default null, p_budget numeric default null,
  p_budget_currency text default 'USD', p_wishes text default null,
  p_consent boolean default false
) returns uuid
  language sql security definer set search_path = public, app, pg_temp as $$
  select app.submit_request(p_phone, p_name, p_deal, p_housing_type, p_rooms,
                            p_district, p_budget, p_budget_currency, p_wishes, p_consent)
$$;

create function public.take_request(p_id uuid) returns void
  language sql security invoker set search_path = public, app, pg_temp as $$
  select app.take_request(p_id) $$;

create function public.release_request(p_id uuid) returns void
  language sql security invoker set search_path = public, app, pg_temp as $$
  select app.release_request(p_id) $$;

create function public.close_request(p_id uuid, p_reason text) returns void
  language sql security invoker set search_path = public, app, pg_temp as $$
  select app.close_request(p_id, p_reason) $$;

create function public.answer_request(p_id uuid, p_note text) returns void
  language sql security invoker set search_path = public, app, pg_temp as $$
  select app.answer_request(p_id, p_note) $$;

create function public.convert_request(p_id uuid) returns uuid
  language sql security invoker set search_path = public, app, pg_temp as $$
  select app.convert_request(p_id) $$;

-- Право выполнения по умолчанию достаётся PUBLIC — снимаем и раздаём точно.
revoke all on function public.submit_request(text, text, text, text, int, text, numeric, text, text, boolean) from public;
revoke all on function public.take_request(uuid)    from public;
revoke all on function public.release_request(uuid) from public;
revoke all on function public.close_request(uuid, text) from public;
revoke all on function public.answer_request(uuid, text) from public;
revoke all on function public.convert_request(uuid) from public;

grant execute on function public.submit_request(text, text, text, text, int, text, numeric, text, text, boolean) to anon, authenticated;
grant execute on function public.take_request(uuid)    to authenticated;
grant execute on function public.release_request(uuid) to authenticated;
grant execute on function public.close_request(uuid, text) to authenticated;
grant execute on function public.answer_request(uuid, text) to authenticated;
grant execute on function public.convert_request(uuid) to authenticated;
