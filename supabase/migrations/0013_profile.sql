-- 0013_profile.sql
--
-- Экран профиля: агент правит своё имя и телефон.
--
-- Упирается в то, что политика agents_read из 0006 требует одобренного
-- агента (`app.current_agent_id() is not null`), поэтому неодобренный не
-- видел даже СВОЮ строку. Следствие было не только про чтение: Postgres
-- применяет SELECT-политику при поиске строк для UPDATE, поэтому
-- `update agents set full_name = ... where auth_user_id = auth.uid()`
-- у неодобренного задевал 0 строк — молча, без ошибки.
--
-- Это мешало и экрану одобрения: админ видел заявку с почтой вместо имени,
-- а человек не мог вписать имя, пока его не одобрят. Замкнутый круг.

-- ---------------------------------------------------------------------------
-- Свою строку агент видит всегда
-- ---------------------------------------------------------------------------
-- Политики складываются по OR, поэтому это только РАСШИРЕНИЕ: одобренные
-- как и раньше видят всех, остальные — ровно себя. О других агентах
-- неодобренный по-прежнему не узнаёт ничего.
--
-- Заблокированному это тоже нужно: иначе кабинет не может объяснить
-- человеку, что доступ отозван, и показывает общий экран ожидания.

create policy agents_read_self on agents for select
  using (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Имя не может быть пустым
-- ---------------------------------------------------------------------------
-- Иначе агент стирает себе имя, и на экране одобрения остаётся пустая
-- строка вместо того, кого нужно опознать.

alter table agents
  add constraint agents_full_name_not_blank check (length(btrim(full_name)) > 0);

-- ---------------------------------------------------------------------------
-- Правка своего профиля
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, и единственная защита — `where auth_user_id = v_uid`:
-- дотянуться до чужой строки функцией нельзя, потому что идентификатор
-- агента она не принимает вовсе.
--
-- Статус и роль в SET не входят. Даже если бы входили, их отбил бы триггер
-- b_guard_agent_privileges из 0011.

create or replace function update_my_profile(
  p_full_name text,
  p_phone     text default null
) returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_full_name, ''));
  r      agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth' using errcode = '42501';
  end if;

  if v_name = '' then
    raise exception 'Имя не может быть пустым' using errcode = 'check_violation';
  end if;

  update agents
     set full_name = v_name,
         -- Пустая строка из формы — это «телефона нет», а не пустой телефон.
         phone     = nullif(btrim(coalesce(p_phone, '')), '')
   where auth_user_id = v_uid
  returning * into r;

  if r.id is null then
    raise exception 'агент не найден: сначала войдите' using errcode = 'no_data_found';
  end if;

  return r;
end $$;

comment on function update_my_profile is
  'Правка своего имени и телефона. Чужую строку задеть нельзя: идентификатор агента функция не принимает.';

grant execute on function update_my_profile(text, text) to authenticated;
