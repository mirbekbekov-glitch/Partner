// Подпись структуры базы: то, по чему две базы можно признать одинаковыми.
//
// Сравниваются не данные, а устройство: отношения, столбцы с типами и
// значениями по умолчанию, функции (вместе с признаком security definer),
// политики RLS с их выражениями, триггеры и ограничения.
//
// Политики здесь важнее всего. Вся защита продукта — в них, и потерянный или
// склеенный `create policy` обязан быть виден: схема, у которой «почти все»
// политики, защищает не то, что проверяют тесты.
//
// Модуль общий у двух проверок: db/check-split.mjs сверяет разбор на операторы
// с psql, а db/push-hosted.mjs --verify сверяет размещённую базу с местной.

export const SIGNATURE = {
  "отношения": `
    select c.relkind::text || ' ' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','app') and c.relkind in ('r','v','m','S','i','p')`,
  "столбцы": `
    select n.nspname || '.' || c.relname || '.' || a.attname || ' ' ||
           format_type(a.atttypid, a.atttypmod) || ' ' ||
           a.attnotnull::text || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
    from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname in ('public','app') and a.attnum > 0 and not a.attisdropped`,
  "функции": `
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
           p.prosecdef::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','app')
      -- Функции расширений исключены: pgcrypto местно ставится в public, а в
      -- Supabase он уже стоит в extensions. Это свойство платформы, а не
      -- нашей схемы, и сравнивать его значит сравнивать не то. Что при этом
      -- проверено отдельно: под ролями anon и authenticated путь поиска
      -- включает extensions, и gen_random_uuid, crypt и digest разрешаются —
      -- то есть разница действительно безвредна, а не объявлена безвредной.
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
      )`,
  "политики": `
    select n.nspname || '.' || c.relname || ' ' || pol.polname || ' ' || pol.polcmd::text ||
           ' ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') ||
           ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
    -- Только наши схемы. Без этого в сравнение попадали политики cron.job,
    -- которые создаёт pg_cron, и результат зависел от того, установлено ли
    -- расширение на обеих сторонах. Та же платформенная примесь, что с
    -- pgcrypto: сравнивать надо нашу схему, а не чужую.
    where n.nspname in ('public','app')`,
  "триггеры": `
    select n.nspname || '.' || c.relname || ' ' || t.tgname
    from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','app')`,
  "ограничения": `
    select n.nspname || '.' || c.relname || ' ' || con.conname || ' ' ||
           pg_get_constraintdef(con.oid)
    from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','app')`,
};

/** Имена разделов подписи в порядке вывода. */
export const PARTS = Object.keys(SIGNATURE);
