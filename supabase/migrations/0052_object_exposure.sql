-- 0052_object_exposure.sql
-- Экспозиция объекта: сколько раз открывали карточку и сколько обращений
-- пришло. Пункт P0.3 спецификации, «обратный поток».
--
-- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Спецификация просит просмотры, раскрытия телефона
-- и звонки С ПЛОЩАДКИ. Площадка нам их не отдаёт: у lalafo.kg и house.kg нет
-- для нас ни API, ни личного кабинета партнёра, а взять эти числа иначе
-- значило бы лезть к ним за данными без договора. Поэтому их здесь нет.
--
-- Экран площадок уже говорит это прямо: «Площадка не сообщает нам, что она
-- разместила объект, и утверждать это за неё значит врать собственнику в
-- отчёте. Мы знаем своё: что отдаём и когда за фидом приходили». Эта
-- миграция добавляет третье, что мы знаем: ЧТО ПРОИСХОДИТ НА НАШЕМ КАТАЛОГЕ.
--
-- Для агента это отвечает на вопрос, которого сегодня нет ответа: «объект
-- висит месяц — его вообще кто-нибудь смотрит?». Ноль открытий и ноль
-- обращений — это разговор о цене и фотографиях. Сто открытий и ноль
-- обращений — разговор другой.
--
-- СЧЁТЧИК, А НЕ ЖУРНАЛ ПОСЕЩЕНИЙ. Хранится одна строка на объект и день:
-- сколько раз открыли. Ни адреса, ни отпечатка браузера, ни сессии.
--
-- Это не экономия места. Журнал посещений каталога недвижимости — это запись
-- о том, кто какой квартирой интересуется, то есть персональные данные,
-- которых мы не собираем и собирать не хотим (та же мысль, что в инварианте
-- 14 про телефоны кандидатов). Вопрос «смотрят ли объект» на суточных
-- счётчиках отвечается полностью, а вопрос «кто смотрел» на них не
-- отвечается вовсе — и это сознательно.
--
-- Образец взят у owner_access.view_count: там счётчик на строке с той же
-- целью и по той же причине.

create table object_views (
  object_id uuid    not null references objects(id) on delete cascade,
  day       date    not null,
  views     integer not null default 0 check (views >= 0),
  primary key (object_id, day)
);

comment on table object_views is
  'Открытия публичной карточки объекта, по суткам. Счётчик, а не журнал посещений: ни адреса, ни отпечатка браузера здесь нет и не будет.';
comment on column object_views.views is
  'Сколько раз за эти сутки открыли карточку на НАШЕМ каталоге. Не просмотры на площадке: их площадка нам не сообщает.';

-- ---------------------------------------------------------------------------
-- Отметить открытие
-- ---------------------------------------------------------------------------
-- Считается только ОПУБЛИКОВАННЫЙ объект, и это не про аккуратность счёта.
--
-- Функция вызывается анонимом, то есть кем угодно. Если бы она считала любой
-- идентификатор, по ней можно было бы проверять существование объекта:
-- подставил uuid, счётчик сдвинулся — значит такой объект есть. Для
-- неопубликованных это утечка самого факта их наличия.
--
-- Поэтому чужой или несуществующий идентификатор не делает НИЧЕГО и не
-- сообщает об этом: молчание одинаково для «нет такого» и «есть, но не
-- опубликован».

create or replace function app.note_object_view(p_object_id uuid)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into object_views (object_id, day, views)
  select o.id, current_date, 1
    from objects o
   where o.id = p_object_id
     and o.publication_state = 'published'
  on conflict (object_id, day) do update
     set views = object_views.views + 1;
end $$;

comment on function app.note_object_view is
  'Отмечает открытие публичной карточки. Неопубликованный или несуществующий объект не считается и не отличается от него по ответу: иначе функция стала бы способом проверять существование объектов.';

revoke execute on function app.note_object_view(uuid) from public;
grant execute on function app.note_object_view(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Уборка
-- ---------------------------------------------------------------------------
-- Год с хвостом: столько, сколько нужно, чтобы сравнить сезон с сезоном.
-- Дальше счётчики ни на один вопрос не отвечают, а место занимают.

create or replace function app.purge_object_views() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v integer;
begin
  delete from object_views where day < current_date - 400;
  get diagnostics v = row_count;
  return v;
end $$;

comment on function app.purge_object_views is
  'Удаляет счётчики открытий старше 400 дней: год с хвостом хватает на сравнение сезонов, дальше они ни на что не отвечают.';

create or replace function app.job_purge_object_views() returns jsonb
  language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('view_days_removed', app.purge_object_views())
$$;

-- Права на уборку отзываются у PUBLIC явно.
--
-- Первая версия этой миграции их не отозвала, и две существующие проверки
-- поймали это сразу: инвариант 15 («ни одной нашей функции, открытой
-- PUBLIC») и инвариант 18 («службе входа открыты ровно шесть функций и ни
-- одной больше»). Дефект был настоящий: purge_object_views УДАЛЯЕТ строки, и
-- вызвать её мог кто угодно, включая анонима.
--
-- Инвариант 15 написан так, чтобы валить миграцию, которой ещё нет: он
-- смотрит на схему целиком, а не на список имён. Этот случай — ровно то, ради
-- чего он такой.
revoke execute on function
  app.purge_object_views(), app.job_purge_object_views()
  from public;

insert into maintenance_jobs (job, description, cron_expression, max_silence, handler) values
  ('purge_object_views',
   'Уборка суточных счётчиков открытий старше 400 дней',
   '41 5 * * *', interval '36 hours',
   'app.job_purge_object_views()'::regprocedure);

-- ---------------------------------------------------------------------------
-- Экспозиция
-- ---------------------------------------------------------------------------
-- Представление читается правами вызывающего: что агенту не видно по
-- политикам, то не видно и здесь.
--
-- Обращения считаются по about_object_id — «обращение ПРО этот объект», а не
-- по object_id, который означает «обращение превратилось в этот объект».
-- Перепутать их значит посчитать в экспозицию то, что ею не является.

create or replace view object_exposure_v
  with (security_invoker = true) as
select
  o.id as object_id,
  o.publication_state,
  case when o.published_at is null then null
       else (current_date - o.published_at::date) end as days_published,
  coalesce((select sum(v.views) from object_views v
             where v.object_id = o.id), 0)::integer as views_total,
  coalesce((select sum(v.views) from object_views v
             where v.object_id = o.id and v.day > current_date - 7), 0)::integer as views_7,
  coalesce((select sum(v.views) from object_views v
             where v.object_id = o.id and v.day > current_date - 30), 0)::integer as views_30,
  (select max(v.day) from object_views v
    where v.object_id = o.id and v.views > 0) as last_view_day,
  (select count(*) from inquiries i
    where i.about_object_id = o.id)::integer as inquiries_total
from objects o;

comment on view object_exposure_v is
  'Экспозиция объекта на НАШЕМ каталоге: открытия карточки по суткам и обращения про этот объект. Площадочных просмотров здесь нет: площадка их не сообщает.';

grant select on object_exposure_v to authenticated;
revoke all on object_exposure_v from anon;

-- ---------------------------------------------------------------------------
-- Права на саму таблицу
-- ---------------------------------------------------------------------------
-- ПИСАТЬ не может никто: ни одной политики на insert, update и delete здесь
-- нет, и счётчик меняется только функцией выше. Счётчик, который можно
-- поправить снаружи, — это не измерение, а мнение.
--
-- ЧИТАТЬ агент может ровно те строки, объекты которых ему и так видны.
-- Первая версия закрывала таблицу наглухо — и представление перестало
-- работать: оно читается правами вызывающего, то есть не может прочитать
-- основу, закрытую от вызывающего. Поймалось не тестом, а проходом браузера:
-- карточка объекта падала с «permission denied for table object_views».
--
-- Тест этого не поймал, потому что оконные проверки шли под postgres, а под
-- агентом читались только обращения. То есть проверка обходила ровно тот
-- путь, которым ходит приложение. Теперь она ходит тем же.
--
-- Политика не повторяет правила видимости объектов, а СПРАШИВАЕТ их: вложенный
-- select сам идёт под политиками objects. Один источник правды, и новая
-- политика на объектах автоматически действует и здесь.

alter table object_views enable row level security;

create policy object_views_read on object_views for select
  using (exists (select 1 from objects o where o.id = object_views.object_id));

revoke all on object_views from anon, authenticated;
grant select on object_views to authenticated;
