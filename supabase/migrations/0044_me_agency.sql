-- 0044_me_agency.sql
-- Кабинету нужно знать, кто вошёл — целиком.
--
-- НЕ инвариант: правил здесь не устанавливается. После инвариантов 33 и 34 у
-- агента появились агентство, направления и роль руководителя, а me_v про
-- них не знала. Экран, который этого не знает, не может ни показать нужные
-- воронки, ни решить, рисовать ли фильтр по агентам.

drop view if exists me_v;

create view me_v
  with (security_invoker = true) as
select a.id, a.full_name, a.email, a.phone, a.role, a.status,
       a.email_verified_at, a.phone_verified_at,
       a.telegram_id, a.created_at,
       a.directions,
       ag.id   as agency_id,
       ag.name as agency_name,
       app.is_admin() as is_admin,
       app.is_head()  as is_head
  from agents a
  join agencies ag on ag.id = a.agency_id
 where a.auth_user_id = auth.uid();

comment on view me_v is
  'Текущий вошедший агент: кто он, какого агентства, какие направления ведёт и руководитель ли. Пустая выборка означает, что входа нет или агент не одобрен.';

-- Пересозданный вид теряет права вместе со старым. Это тот случай, когда
-- молчаливая потеря прав выглядит как поломка кабинета, а не как отказ.
grant select on me_v to authenticated;
revoke all on me_v from anon;

-- Политика агентств расширяется до любого вошедшего, и это нашлось сразу:
-- me_v соединяется с agencies, а неодобренный агент не проходил проверку
-- app.current_agent_id() — строка о нём исчезала целиком, и кабинет не мог
-- показать ему даже «вы ждёте одобрения».
--
-- Названия агентств тайной и не были: они отдаются в listing_terms_v
-- каждому агенту платформы вместе с чужим объектом.
drop policy agencies_read on agencies;
create policy agencies_read on agencies for select
  using (auth.uid() is not null);
