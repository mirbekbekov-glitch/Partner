import 'server-only';
import { one } from './sql';
import { currentAgent, isAdmin } from './session';

/**
 * Кому что видно и что править — инвариант 4 и права на объект.
 *
 * В Postgres это держали политики RLS поверх app.can_see_contact() и
 * app.can_edit_object(). Политика ограничивала СТРОКИ: даже если страница
 * забывала проверить, база не отдавала чужое.
 *
 * Здесь такого страховочного слоя нет, поэтому правило ровно одно: ни один
 * запрос, отдающий телефон или правящий объект, не пишется мимо этих
 * функций. Проверка стоит перед выдачей, а не после.
 */

/**
 * Телефон контакта виден: тому, кто привёл контакт; агентам внутри активной
 * сделки, где этот контакт — собственник объекта или клиент; админу.
 *
 * Перенос app.can_see_contact() один в один, включая состав случаев: сузить
 * его нельзя, не отобрав доступ у участника идущей сделки, а расширить —
 * значит сломать инвариант 4.
 */
export async function canSeeContact(contactId: string): Promise<boolean> {
  if (await isAdmin()) return true;

  const agent = await currentAgent();
  if (!agent) return false;

  const hit = await one<{ ok: number }>(
    `select 1 as ok where
       exists (select 1 from contacts c
                where c.id = ?1 and c.owner_agent_id = ?2)
       -- участник активной сделки, где контакт — собственник объекта
       or exists (select 1
                    from deals d
                    join object_ownerships oo on oo.object_id = d.object_id
                   where oo.contact_id = ?1
                     and d.status not in ('closed', 'failed')
                     and ?2 in (d.listing_agent_id, d.closing_agent_id))
       -- участник активной сделки, где контакт — клиент
       or exists (select 1
                    from deals d
                    join requirements r on r.id = d.requirement_id
                   where r.contact_id = ?1
                     and d.status not in ('closed', 'failed')
                     and ?2 in (d.listing_agent_id, d.closing_agent_id))`,
    contactId, agent.id,
  );

  return hit !== null;
}

/**
 * Объект правит: тот, кто его завёл; listing-агент активного мандата; админ.
 *
 * Перенос app.can_edit_object(). Тот же предикат отвечает и за доступ к
 * телефонам заявителей по объекту — иначе вышло бы, что снять объект с
 * публикации агент может, а читать заявки по нему нет.
 */
export async function canEditObject(objectId: string): Promise<boolean> {
  if (await isAdmin()) return true;

  const agent = await currentAgent();
  if (!agent) return false;

  const hit = await one<{ ok: number }>(
    `select 1 as ok where
       exists (select 1 from objects o
                where o.id = ?1 and o.created_by_agent_id = ?2)
       or exists (select 1 from mandates m
                   where m.object_id = ?1
                     and m.status = 'active'
                     and m.listing_agent_id = ?2)`,
    objectId, agent.id,
  );

  return hit !== null;
}

/** Та же проверка для списка объектов разом: по одному запросу на объект дорого. */
export async function editableObjectIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (await isAdmin()) return new Set(ids);

  const agent = await currentAgent();
  if (!agent) return new Set();

  const holders = ids.map(() => '?').join(', ');
  const rows = await (await import('./sql')).all<{ id: string }>(
    `select o.id from objects o
      where o.id in (${holders})
        and (o.created_by_agent_id = ?
             or exists (select 1 from mandates m
                         where m.object_id = o.id
                           and m.status = 'active'
                           and m.listing_agent_id = ?))`,
    ...ids, agent.id, agent.id,
  );

  return new Set(rows.map((r) => r.id));
}
