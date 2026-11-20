-- 0027_agent_relink.sql
-- ИНВАРИАНТ 6: повторный вход не создаёт дубля и не теряет владение объектами.
--
-- Что было найдено на живом проекте. Администратор удаляет человека в
-- Supabase Auth (или тот удаляется по любой другой причине). Строка agents
-- остаётся с auth_user_id, которого больше нет, а вместе с ней остаются её
-- мандаты, потребности и сделки. Человек входит заново по той же почте —
-- Supabase выдаёт новый uid, ensure_agent() пытается вставить вторую строку
-- и падает:
--
--   duplicate key value violates unique constraint "agents_email_key"
--
-- Вход ломался навсегда, а объекты оставались за строкой, в которую уже
-- никто не может войти. Это прямое нарушение инварианта 6.
--
-- Лечим двумя слоями.
--
-- 1. Связь с auth.users объявляется ссылкой с on delete set null. Удаление
--    пользователя само обнуляет auth_user_id, и «сирота» становится видна
--    одним условием `auth_user_id is null` — без чтения схемы auth, прав на
--    которое у роли миграций может не быть (ровно эта зависимость уже
--    ловилась в 0026).
--
-- 2. ensure_agent() подхватывает такую строку по почте: тот же человек
--    возвращается в свою запись со всеми объектами, а не в пустую новую.
--
-- Почему присвоение по почте безопасно: почта взята из токена, то есть её
-- владение только что подтвердил Supabase письмом. И присваиваем мы ТОЛЬКО
-- строку с пустым auth_user_id — чужую живую запись не тронуть даже при
-- совпадении почты.

-- ---------------------------------------------------------------------------
-- 1. Почта — тоже идентичность
-- ---------------------------------------------------------------------------
-- Проверка из 0010 требовала auth_user_id ИЛИ telegram_id. С ней обнулить
-- auth_user_id нельзя, то есть ссылка с on delete set null ниже не смогла бы
-- сработать: удаление пользователя падало бы на проверке.
--
-- Это не обход проверки, а исправление её состава. Смысл проверки — «строка
-- должна быть достижима каким-нибудь входом». Почта как раз и есть тот вход,
-- по которому человек возвращается в свою запись (путь 2 ниже). Строка без
-- всех трёх признаков по-прежнему запрещена: она владела бы объектами, в
-- которые никто не может войти.
--
-- Следствие, о котором стоит знать: если у агента нет ни почты, ни Telegram,
-- удаление его пользователя в Supabase упадёт на этой проверке. Так и нужно —
-- база отказывается осиротить запись, из которой нет пути назад.

alter table agents drop constraint agents_has_identity;
alter table agents add constraint agents_has_identity
  check (auth_user_id is not null or telegram_id is not null or email is not null);

comment on constraint agents_has_identity on agents is
  'Инвариант 6: у строки агента должен быть хотя бы один признак, по которому '
  'вход её найдёт — auth_user_id, telegram_id или почта.';

-- ---------------------------------------------------------------------------
-- 2. Ссылка на auth.users
-- ---------------------------------------------------------------------------
-- Требует права REFERENCES на auth.users. На Supabase миграции идут под
-- postgres, у которого оно есть; это штатный приём самой Supabase. Если
-- права нет, миграция упадёт здесь и громко — это лучше, чем тихо
-- сломанный вход.

alter table agents
  add constraint agents_auth_user_id_fkey
  foreign key (auth_user_id) references auth.users (id) on delete set null;

comment on column agents.auth_user_id is
  'Инвариант 6. on delete set null: удаление пользователя в Supabase Auth '
  'освобождает строку, и ensure_agent() вернёт в неё того же человека по почте.';

-- ---------------------------------------------------------------------------
-- 3. Вход: своя строка → освободившаяся по почте → новая
-- ---------------------------------------------------------------------------

create or replace function app.ensure_agent(p_full_name text default null)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
  r       agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  -- Почта из токена. Никаких прав на чужие схемы не нужно.
  begin
    v_email := nullif(auth.jwt() ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  -- Запасной путь: таблица пользователей. Нет прав — не беда, вход важнее
  -- почты, и агент впишет имя сам.
  if v_email is null then
    begin
      select u.email into v_email from auth.users u where u.id = v_uid;
    exception when insufficient_privilege or undefined_table then
      v_email := null;
    end;
  end if;

  -- Путь 1: своя строка. Обычный повторный вход.
  update agents
     set full_name  = coalesce(nullif(btrim(p_full_name), ''), full_name),
         email      = coalesce(v_email, email),
         updated_at = now()
   where auth_user_id = v_uid
  returning * into r;
  if found then
    return r;
  end if;

  -- Путь 2: строка этого же человека, оставшаяся без пользователя. Забираем
  -- её вместе со всем, что за ней записано.
  if v_email is not null then
    update agents
       set auth_user_id = v_uid,
           full_name    = coalesce(nullif(btrim(p_full_name), ''), full_name),
           updated_at   = now()
     where email = v_email and auth_user_id is null
    returning * into r;
    if found then
      return r;
    end if;
  end if;

  -- Путь 3: новый человек.
  v_name := coalesce(nullif(btrim(p_full_name), ''), v_email, 'без имени');
  begin
    insert into agents (auth_user_id, full_name, email)
    values (v_uid, v_name, v_email)
    returning * into r;
  exception when unique_violation then
    -- Почту занимает ЖИВАЯ чужая запись. Сказать это прямо, а не отдавать
    -- наружу текст про нарушение ограничения.
    raise exception 'CONFLICT: почта % уже привязана к другому аккаунту', v_email
      using errcode = '23505';
  end;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: вход. Своя строка → освободившаяся строка с той же почтой → новая. '
  'Почта берётся из JWT, а не из auth.users: чтение чужой схемы требует прав, '
  'которых у роли миграций на Supabase может не быть.';
