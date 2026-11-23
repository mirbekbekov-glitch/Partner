-- Источник заявки: откуда пришёл человек
-- ---------------------------------------------------------------------------
-- Заявка с печатного QR-кода и заявка из каталога выглядели одинаково, и
-- понять, что сработало, было нельзя. Метка источника это чинит.
--
-- Поле свободное, а не перечисление: источники заводятся рекламой, а не
-- разработкой, и каждый новый не должен требовать миграции. Длина
-- ограничена — метка это ярлык, а не текст.
--
-- Параметр добавлен ПОСЛЕДНИМ и со значением по умолчанию: прежние вызовы
-- с позиционными аргументами, включая тесты, продолжают работать.

alter table requests
  add column source text
    check (source is null or length(btrim(source)) between 2 and 60);

comment on column requests.source is
  'Откуда пришла заявка: метка кампании или QR-кода, например chayka-qr. '
  'Ставится при создании; повтор того же номера за сутки сохраняет первый '
  'источник, а не затирает его последним.';

-- Колоночные права. Лента заявок читает таблицу правами вызывающего, и без
-- этой строки агент получает «permission denied» на всю ленту, как только в
-- неё добавлена новая колонка. Метка источника личных данных не содержит,
-- поэтому стоит рядом с остальными открытыми полями, а не за функцией.
grant select (source) on requests to authenticated;

-- Старые подписи снимаем: оставить их рядом с новыми значит получить
-- неоднозначность при вызове из PostgREST.
drop function public.submit_request(text, text, text, text, int, text, numeric, text, text, boolean);
drop function app.submit_request(text, text, text, text, int, text, numeric, text, text, boolean);

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
  p_consent        boolean default false,
  p_source         text    default null
) returns uuid
  language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  v_phone text := btrim(coalesce(p_phone, ''));
  v_norm  text := app.normalize_phone(v_phone);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_wish  text := nullif(btrim(coalesce(p_wishes, '')), '');
  v_src   text := left(nullif(btrim(coalesce(p_source, '')), ''), 60);
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
    budget, budget_currency, wishes, name, phone, public_consent, source
  ) values (
    v_deal, v_kind,
    case when p_rooms between 1 and 20 then p_rooms::smallint end,
    v_district_id, v_district_other,
    case when p_budget > 0 then p_budget end,
    case when upper(coalesce(p_budget_currency, 'USD')) in ('USD', 'KGS')
         then upper(p_budget_currency) else 'USD' end,
    v_wish, v_name, v_phone, coalesce(p_consent, false), v_src
  ) returning id into v_id;

  return v_id;
end;
$$;

comment on function app.submit_request is
  'Приём заявки от неизвестного. Обязателен только телефон. Повтор того же '
  'номера за сутки возвращает прежнюю заявку, а не создаёт вторую.';

create function public.submit_request(
  p_phone text, p_name text default null, p_deal text default null,
  p_housing_type text default null, p_rooms int default null,
  p_district text default null, p_budget numeric default null,
  p_budget_currency text default 'USD', p_wishes text default null,
  p_consent boolean default false, p_source text default null
) returns uuid
  language sql security definer set search_path = public, app, pg_temp as $$
  select app.submit_request(p_phone, p_name, p_deal, p_housing_type, p_rooms,
                            p_district, p_budget, p_budget_currency, p_wishes,
                            p_consent, p_source)
$$;

revoke all on function public.submit_request(text, text, text, text, int, text, numeric, text, text, boolean, text) from public;
grant execute on function public.submit_request(text, text, text, text, int, text, numeric, text, text, boolean, text) to anon, authenticated;


create or replace view request_feed_v
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
  extract(epoch from coalesce(r.first_response_at, now()) - r.created_at)::int / 60 as response_minutes,

  -- Откуда пришла заявка: метка кампании, QR-кода, страницы.
  r.source
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
