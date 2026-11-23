-- 0054_owner_access_view.sql
-- Открытие ссылки собственника перестало переспрашивать правила её выдачи.
--
-- ДЕФЕКТ. app.owner_report() и app.owner_cabinet() поднимают счётчик
-- просмотров, то есть ОБНОВЛЯЮТ строку owner_access. На обновлении
-- срабатывал триггер b_owner_access и проверял заново всё, что относится к
-- ВЫДАЧЕ ссылки, — в том числе «на объекте есть действующий договор».
--
-- Пока договор действует, никто этого не замечает. Но договор кончается:
-- закрывается сделкой или истекает по сроку. С этого мгновения собственник,
-- открывая свою ссылку, получал не страницу и не объяснение, а пятисотую
-- ошибку — при попытке посчитать его же просмотр.
--
-- Нашлось проходом в ширину телефона: он открывает все страницы подряд,
-- включая те, на которые в кабинет не заходят.
--
-- ИНВАРИАНТ НЕ СЛАБЕЕТ. Завести негодную строку нельзя по-прежнему, и
-- перенацелить существующую на другой объект, контакт или выдавшего агента
-- тоже. Проверка молчит ровно там, где менять нечего: счётчик просмотров,
-- время последнего открытия, отзыв, срок.
--
-- Тело взято из базы дословно, добавлена одна проверка в начале.

CREATE OR REPLACE FUNCTION app.check_owner_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_listing uuid;
begin
  -- НА ОБНОВЛЕНИИ правила выдачи переспрашиваются только тогда, когда
  -- изменилось то, о чём они: объект, контакт или выдавший агент.
  --
  -- Раньше они переспрашивались на любом обновлении — а обновление случается
  -- при каждом ОТКРЫТИИ ссылки: app.owner_report() и app.owner_cabinet()
  -- поднимают счётчик просмотров. Правила же говорят о выдаче и требуют
  -- действующего договора. Как только договор закрывался сделкой или истекал
  -- по сроку, ссылка, уже отданная собственнику, начинала отвечать
  -- «INVARIANT_10: на объекте нет активного мандата» — то есть пятисотой
  -- страницей, при попытке посчитать просмотр.
  --
  -- Инвариант от этого не слабеет: завести негодную строку по-прежнему
  -- нельзя, и перенацелить существующую на другой объект, контакт или
  -- выдавшего агента тоже. Открыть ссылку и отозвать её можно всегда — отзыв
  -- обязан работать и после конца договора, иначе доступ закрыть нечем.
  --
  -- Должна ли ссылка переставать работать вместе с договором — вопрос
  -- продукта, а не этого триггера. Сегодня она работает, и отчёт честно
  -- показывает то, что было. Если решим закрывать, это будет условие в
  -- app.owner_report(), с человеческим ответом вместо пятисотой страницы.
  if tg_op = 'UPDATE'
     and new.object_id is not distinct from old.object_id
     and new.contact_id is not distinct from old.contact_id
     and new.issued_by_agent_id is not distinct from old.issued_by_agent_id
  then
    return new;
  end if;
  -- Кабинет: контакт обязан быть собственником хотя бы одного объекта с
  -- действующим договором, а выдать кабинет может агент любого из них.
  if new.object_id is null then
    if not exists (
      select 1 from object_ownerships oo
       join mandates m on m.object_id = oo.object_id and m.status = 'active'
      where oo.contact_id = new.contact_id
        and oo.role in ('owner', 'co_owner', 'proxy')
        and (m.listing_agent_id = new.issued_by_agent_id or app.is_admin())
    ) then
      raise exception
        'INVARIANT_29: кабинет выдаётся собственнику объекта с действующим договором, и выдаёт его агент этого договора'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Токен выдаётся собственнику ЭТОГО объекта, а не любому контакту.
  if not exists (
    select 1 from object_ownerships oo
     where oo.object_id = new.object_id
       and oo.contact_id = new.contact_id
       and oo.role in ('owner', 'co_owner', 'proxy')
  ) then
    raise exception
      'INVARIANT_10: контакт % не числится собственником объекта %',
      new.contact_id, new.object_id
      using errcode = 'check_violation';
  end if;

  select m.listing_agent_id into v_listing
    from mandates m
   where m.object_id = new.object_id and m.status = 'active';

  if v_listing is null then
    raise exception
      'INVARIANT_10: на объекте % нет активного мандата, отчёт выдавать не о чем',
      new.object_id using errcode = 'check_violation';
  end if;

  if new.issued_by_agent_id <> v_listing and not app.is_admin() then
    raise exception
      'INVARIANT_10: ссылку выдаёт listing-агент мандата (%), а не любой агент',
      v_listing using errcode = 'check_violation';
  end if;

  return new;
end $function$;
