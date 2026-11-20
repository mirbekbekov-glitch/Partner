-- 0020_cabinet_grants.sql
-- ИНВАРИАНТ 15, вторая половина: правило про PUBLIC распространяется на
--              схему public, где живут функции кабинета.
--
-- 0018 закрыл схему app и на этом остановился. А функции кабинета —
-- claim_candidate(), create_match(), issue_owner_access(), close_deal() и
-- остальные — лежат в схеме public, и все до одной были доступны PUBLIC,
-- то есть роли anon: Postgres выдаёт EXECUTE всем по умолчанию, а отдельного
-- revoke для них никто не писал.
--
-- Это проверено вызовом, и здесь нужна точность. Дыры, как в app, не было:
-- каждая функция кабинета начинается с проверки агента и отвечает анониму
-- «FORBIDDEN: требуется одобренный агент». То есть защита была, но держалась
-- на том, что ни один автор функции об этой строке не забудет.
--
-- Разница между «никто не забыл» и «забыть нельзя» — это и есть разница между
-- внимательностью и инвариантом. Проверка агента остаётся вторым слоем;
-- первым становится право вызова.
--
-- Расширения не трогаем: gen_random_uuid(), digest() и прочее из pgcrypto
-- живут в public и должны быть доступны всем. Поэтому отбор идёт по
-- принадлежности расширению, а не по именам.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       -- Функции, принадлежащие расширению, не наши: их права ставит
       -- расширение, и ломать их мы не вправе.
       and not exists (select 1 from pg_depend d
                        where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public', r.fn);
    execute format('grant  execute on function %s to authenticated', r.fn);
  end loop;
end $$;

-- Отчёт собственника открывается по ссылке, без входа: это единственная
-- функция кабинета, которая нужна анониму. Она в схеме app и права получила
-- в 0013; здесь только напоминание, почему в списке ниже её нет.

-- Проверка расширяется на обе схемы. Сигнатура меняется, поэтому функция
-- пересоздаётся заново, а не правится.
drop function if exists app.functions_open_to_public();

create or replace function app.functions_open_to_public()
  returns table (schema_name text, function_name text, is_definer boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
  select n.nspname::text, p.proname::text, p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'public')
     and p.prokind = 'f'
     -- Пустой грантополучатель в ACL — это и есть PUBLIC. Пустой proacl
     -- означает умолчание, то есть тоже PUBLIC.
     and (p.proacl is null or array_to_string(p.proacl, ' ') like '=%')
     -- Чужое не считаем: права функций расширения ставит расширение.
     and not exists (select 1 from pg_depend d
                      where d.objid = p.oid and d.deptype = 'e')
   order by n.nspname, p.proname
$$;

comment on function app.functions_open_to_public is
  'Инвариант 15. Наши функции схем app и public, доступные PUBLIC. Непустой результат — ошибка в правах, а не отчёт.';

revoke execute on function app.functions_open_to_public() from public;
grant  execute on function app.functions_open_to_public() to authenticated;
