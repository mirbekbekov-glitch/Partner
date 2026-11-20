-- 0010_optional_telegram.sql
--
-- Вход через Telegram решено не делать, поэтому telegram_id становится
-- необязательным, а якорь ИНВАРИАНТА 6 переезжает на auth_user_id.
--
-- Суть инварианта не меняется: один человек — один аккаунт, повторный вход
-- не создаёт дубликат и не теряет владение объектами. Меняется только то,
-- чем он закреплён — вместо Telegram-идентичности это идентичность
-- Supabase Auth.
--
-- Авторизацию это не задевает вовсе: app.current_agent_id() и app.is_admin()
-- с самого начала опознают агента по agents.auth_user_id = auth.uid(), а не
-- по telegram_id. Инвариант 4, гейт «CRM только одобренным» и все политики
-- RLS работают как работали.
--
-- Вперёд-миграция, а не правка 0001: 0001 мог быть уже применён, и тогда
-- пересборка с нуля и миграция вперёд дали бы разные схемы.

-- ---------------------------------------------------------------------------
-- telegram_id: необязателен, но по-прежнему уникален
-- ---------------------------------------------------------------------------
-- UNIQUE остаётся. В Postgres несколько NULL уникальность не нарушают,
-- поэтому агентов без Telegram может быть сколько угодно, а вот два
-- аккаунта на один и тот же telegram_id — всё так же нельзя.

alter table agents alter column telegram_id drop not null;

-- ---------------------------------------------------------------------------
-- Хотя бы одна идентичность обязательна
-- ---------------------------------------------------------------------------
-- Без этого инвариант 6 получил бы дыру. Строка агента без auth_user_id и
-- без telegram_id ни с каким входом не сопоставляется, но владеть контактами
-- и объектами может. Человек потом логинится, получает НОВУЮ строку, а
-- объекты остаются за мёртвой — ровно та потеря владения, которую
-- инвариант 6 запрещает.

alter table agents add constraint agents_has_identity
  check (auth_user_id is not null or telegram_id is not null);

comment on constraint agents_has_identity on agents is
  'Инвариант 6: у агента обязана быть идентичность, иначе его объекты осиротеют при первом входе.';

comment on column agents.telegram_id is
  'Необязателен (0010). Если задан — уникален: два аккаунта на один Telegram невозможны.';

comment on column agents.auth_user_id is
  'Якорь инварианта 6 (0010). auth.users.id из Supabase Auth. По нему app.current_agent_id() опознаёт агента, и по нему же app.ensure_agent() делает upsert, поэтому повторный вход не плодит дубликат.';

-- ---------------------------------------------------------------------------
-- Вход: upsert по идентичности Supabase Auth
-- ---------------------------------------------------------------------------
-- Авторизационный аналог app.login_by_telegram(): та же защита от дубликата,
-- только по auth.uid(). Вызывается после входа в Supabase Auth — любым
-- способом: почта, OAuth, magic link.
--
-- Новый агент получает status = 'pending' по умолчанию: CRM открывается
-- только после одобрения, и эта функция такого права не даёт.

create or replace function app.ensure_agent(p_full_name text)
  returns agents
  language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  r     agents;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: нет сессии Supabase Auth'
      using errcode = '42501';
  end if;

  insert into agents (auth_user_id, full_name)
  values (v_uid, p_full_name)
  on conflict (auth_user_id) do update
     set full_name  = excluded.full_name,
         updated_at = now()
  returning * into r;

  return r;
end $$;

comment on function app.ensure_agent is
  'Инвариант 6: единственный путь входа без Telegram. Upsert по auth.uid(), поэтому повторный вход возвращает ту же строку и не теряет владение объектами.';

grant execute on function app.ensure_agent(text) to authenticated;
