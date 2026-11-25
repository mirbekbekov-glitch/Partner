import 'server-only';
import { all, jsonArray, one } from './sql';
import { requireAgent } from './session';
import { fromMinor } from './money';
import { commissionShares, commissionTotal, parseRule } from './commission';
import { contactVisible, dealParty, objectEditable } from './visibility';

/**
 * Запросы кабинета: списки и карточки.
 *
 * В Postgres это были пятнадцать представлений поверх RLS. Представление
 * описывало СОСТАВ, а видимость обеспечивала политика, поэтому в самом
 * тексте представления условий доступа почти не было.
 *
 * Здесь политик нет, и видимость живёт в запросе — предикатами из
 * visibility.ts. Соглашение оттуда действует и тут: ?1 это всегда текущий
 * агент, остальное с ?2.
 *
 * Скрытый контакт отдаётся как null, а не пропадает вместе со строкой. Это
 * прямое требование инварианта 4 в UI: агент должен видеть, что объект
 * ведёт коллега, и не видеть, кто собственник, — а не получать пустой
 * список, из которого непонятно, есть объект или нет.
 */

type Params = (string | number)[];

/** Кто спрашивает. Один вызов на запрос, а не на строку. */
async function asker() {
  const agent = await requireAgent();
  return { id: agent.id, admin: agent.role === 'admin' };
}

// ---------------------------------------------------------------------------
// Контакты
// ---------------------------------------------------------------------------

export type ContactListItem = {
  id: string;
  kind: string;
  name: string;
  telegram: string | null;
  source: string | null;
  roles: string[];
  note: string | null;
  created_at: string;
  owner_agent_id: string;
  owner_name: string | null;
  mine: boolean;
  phones: string | null;
  objects_count: number;
  requirements_count: number;
  open_requirements: number;
};

export async function contactList(search?: string | null): Promise<ContactListItem[]> {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const params: Params = [me.id, ...visible.params.slice(1)];
  let filter = '';

  if (search?.trim()) {
    filter = 'and (lower(c.name) like ?2 or exists (select 1 from contact_phones cp'
           + ' where cp.contact_id = c.id and cp.phone_normalized like ?3))';
    const text = search.trim().toLowerCase();
    params.push(`%${text}%`, `%${text.replace(/\D/g, '')}%`);
  }

  const rows = await all<Omit<ContactListItem, 'roles' | 'mine'> & {
    roles: string; mine: number;
  }>(
    `select c.id, c.kind, c.name, c.telegram, c.source, c.roles, c.note,
            c.created_at, c.owner_agent_id,
            ag.full_name as owner_name,
            (c.owner_agent_id = ?1) as mine,
            (select group_concat(cp.phone, ', ') from contact_phones cp
              where cp.contact_id = c.id) as phones,
            (select count(*) from object_ownerships oo where oo.contact_id = c.id)
              as objects_count,
            (select count(*) from requirements r where r.contact_id = c.id)
              as requirements_count,
            (select count(*) from requirements r where r.contact_id = c.id
               and r.status not in ('closed', 'lost')) as open_requirements
       from contacts c
       left join agents ag on ag.id = c.owner_agent_id
      where ${visible.sql} ${filter}
      order by c.created_at desc limit 200`,
    ...params,
  );

  return rows.map((r) => ({
    ...r,
    roles: jsonArray<string>(r.roles),
    mine: r.mine === 1,
  }));
}

/** Объекты контакта: что он продаёт или сдаёт. */
export async function contactObjects(contactId: string) {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  return all<{
    object_id: string; ownership_role: string; share: number | null;
    address: string; price: number; currency: string; publication_state: string;
  }>(
    `select oo.object_id, oo.role as ownership_role, oo.share,
            o.address, o.price_minor / 100.0 as price, o.currency,
            o.publication_state
       from object_ownerships oo
       join objects o on o.id = oo.object_id
       join contacts c on c.id = oo.contact_id
      where oo.contact_id = ?2 and ${visible.sql}
      order by o.created_at desc`,
    me.id, contactId,
  );
}

/**
 * Возможные дубликаты: записи с похожим именем у того же агента.
 *
 * По номеру дубликатов быть не может — номер уникален глобально, — поэтому
 * ищем по имени. Это подсказка, а не утверждение: решает агент.
 */
export async function contactDuplicates(): Promise<Array<{
  a_id: string; a_name: string; b_id: string; b_name: string;
}>> {
  const me = await asker();

  return all(
    `select a.id as a_id, a.name as a_name, b.id as b_id, b.name as b_name
       from contacts a join contacts b
         on lower(trim(a.name)) = lower(trim(b.name)) and a.id < b.id
      where a.owner_agent_id = ?1 and b.owner_agent_id = ?1
      order by a.name limit 50`,
    me.id,
  );
}

// ---------------------------------------------------------------------------
// Объекты
// ---------------------------------------------------------------------------

export type ObjectListItem = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  price: number;
  currency: string;
  publication_state: string;
  published_at: string | null;
  actual_at: string;
  created_at: string;
  mandate_id: string | null;
  contract_confirmed: boolean;
  listing_agent_id: string | null;
  listing_agent_name: string | null;
  owner_name: string | null;
  organization_name: string | null;
  can_edit: boolean;
  leads_new: number;
};

export type ObjectSource = 'mine' | 'org' | 'others' | 'all';

export async function objectList(query: {
  state?: string | null;
  deal?: string | null;
  source?: ObjectSource;
  agentId?: string | null;
} = {}): Promise<ObjectListItem[]> {
  const me = await asker();
  const editable = objectEditable('o', me.id, me.admin);
  const visible = contactVisible('oc', me.id, me.admin);

  const params: Params = [me.id];
  const where: string[] = ['1 = 1'];
  let n = 1;
  const next = () => `?${++n}`;

  if (query.state) { where.push(`o.publication_state = ${next()}`); params.push(query.state); }
  if (query.deal)  { where.push(`o.deal_type = ${next()}`); params.push(query.deal); }

  // Ответственный за объект — listing-агент активного мандата, а у
  // черновика без мандата тот, кто его завёл: иначе такие объекты выпадали
  // бы из любого фильтра по источнику.
  const responsible = `coalesce(
    (select m.listing_agent_id from mandates m
      where m.object_id = o.id and m.status = 'active' limit 1),
    o.created_by_agent_id)`;

  if (query.source === 'mine') {
    where.push(`${responsible} = ?1`);
  } else if (query.source === 'org') {
    where.push(`exists (select 1 from agents a1 join agents a2
                         on a1.organization_id = a2.organization_id
                        where a1.id = ?1 and a2.id = ${responsible}
                          and a1.organization_id is not null)`);
  } else if (query.source === 'others') {
    where.push(`not exists (select 1 from agents a1 join agents a2
                             on a1.organization_id = a2.organization_id
                            where a1.id = ?1 and a2.id = ${responsible}
                              and a1.organization_id is not null)
                and ${responsible} <> ?1`);
  }
  if (query.agentId) { where.push(`${responsible} = ${next()}`); params.push(query.agentId); }

  const rows = await all<Omit<ObjectListItem, 'can_edit' | 'contract_confirmed'> & {
    can_edit: number; contract_confirmed: number | null;
  }>(
    `select o.id, o.kind, o.deal_type, o.address, o.zone, o.rooms, o.area,
            o.floor, o.price_minor / 100.0 as price, o.currency,
            o.publication_state, o.published_at, o.actual_at, o.created_at,
            m.id as mandate_id,
            coalesce(m.contract_confirmed, 0) as contract_confirmed,
            m.listing_agent_id,
            la.full_name as listing_agent_name,
            org.name as organization_name,
            -- Имя собственника — только тому, кому инвариант 4 его открывает.
            (select case when ${visible.sql} then oc.name end
               from object_ownerships oo
               join contacts oc on oc.id = oo.contact_id
              where oo.object_id = o.id and oo.role = 'owner'
              limit 1) as owner_name,
            (${editable.sql}) as can_edit,
            (select count(*) from leads l
              where l.object_id = o.id and l.status = 'new') as leads_new
       from objects o
       left join mandates m on m.object_id = o.id and m.status = 'active'
       left join agents la on la.id = m.listing_agent_id
       left join agents ra on ra.id = ${responsible}
       left join organizations org on org.id = ra.organization_id
      where ${where.join(' and ')}
      order by o.actual_at desc limit 200`,
    ...params,
  );

  return rows.map((r) => ({
    ...r,
    can_edit: r.can_edit === 1,
    contract_confirmed: r.contract_confirmed === 1,
  }));
}

// ---------------------------------------------------------------------------
// Потребности
// ---------------------------------------------------------------------------

export type RequirementListItem = {
  id: string;
  deal_type: 'rent' | 'sale';
  budget_min: number | null;
  budget_max: number | null;
  zones: string[];
  rooms: number[];
  deadline: string | null;
  status: string;
  created_at: string;
  agent_id: string;
  agent_name: string | null;
  client_name: string | null;
  mine: boolean;
  matches_count: number;
};

export async function requirementList(query: {
  status?: string | null;
  mine?: boolean;
} = {}): Promise<RequirementListItem[]> {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const params: Params = [me.id];
  const where: string[] = ['1 = 1'];
  let n = 1;

  if (query.status) { where.push(`r.status = ?${++n}`); params.push(query.status); }
  if (query.mine) where.push('r.agent_id = ?1');

  const rows = await all<Omit<RequirementListItem, 'zones' | 'rooms' | 'mine'> & {
    zones: string; rooms: string; mine: number;
  }>(
    `select r.id, r.deal_type,
            r.budget_min_minor / 100.0 as budget_min,
            r.budget_max_minor / 100.0 as budget_max,
            r.zones, r.rooms, r.deadline, r.status, r.created_at,
            r.agent_id, ag.full_name as agent_name,
            (r.agent_id = ?1) as mine,
            -- Имя клиента — только тому, кому инвариант 4 его открывает.
            (select case when ${visible.sql} then c.name end
               from contacts c where c.id = r.contact_id) as client_name,
            (select count(*) from matches mt where mt.requirement_id = r.id)
              as matches_count
       from requirements r
       left join agents ag on ag.id = r.agent_id
      where ${where.join(' and ')}
      order by r.created_at desc limit 200`,
    ...params,
  );

  return rows.map((r) => ({
    ...r,
    zones: jsonArray<string>(r.zones),
    rooms: jsonArray<number>(r.rooms),
    mine: r.mine === 1,
  }));
}

// ---------------------------------------------------------------------------
// Сделки
// ---------------------------------------------------------------------------

export type DealListItem = {
  id: string;
  status: string;
  address: string;
  deal_type: 'rent' | 'sale';
  final_price: number | null;
  commission_total: number | null;
  listing_share: number | null;
  closing_share: number | null;
  listing_agent_name: string | null;
  closing_agent_name: string | null;
  created_at: string;
  closed_at: string | null;
};

export async function dealList(): Promise<DealListItem[]> {
  const me = await asker();
  const party = dealParty('d', me.id, me.admin);

  const rows = await all<{
    id: string; status: string; address: string; deal_type: 'rent' | 'sale';
    final_price_minor: number | null; price_minor: number;
    commission_total_minor: number | null;
    listing_share_minor: number | null; closing_share_minor: number | null;
    commission_rule: string | null;
    listing_agent_name: string | null; closing_agent_name: string | null;
    created_at: string; closed_at: string | null;
  }>(
    `select d.id, d.status, o.address, o.deal_type,
            d.final_price_minor, o.price_minor, m.commission_rule,
            d.commission_total_minor, d.listing_share_minor, d.closing_share_minor,
            la.full_name as listing_agent_name,
            ca.full_name as closing_agent_name,
            d.created_at, d.closed_at
       from deals d
       join objects o on o.id = d.object_id
       join mandates m on m.id = d.mandate_id
       left join agents la on la.id = d.listing_agent_id
       left join agents ca on ca.id = d.closing_agent_id
      where ${party.sql}
      order by d.created_at desc limit 200`,
    me.id,
  );

  return rows.map((r) => {
    // До закрытия суммы индикативны и считаются на лету; после закрытия
    // отдаются зафиксированные. Записывать индикативные нельзя — записанные
    // означали бы, что деньги уже поделены.
    const fixed = r.commission_total_minor !== null;
    const total = fixed
      ? r.commission_total_minor
      : commissionTotal(r.deal_type, r.final_price_minor ?? r.price_minor,
                        parseRule(r.commission_rule));
    const shares = fixed
      ? { listing: r.listing_share_minor, closing: r.closing_share_minor }
      : commissionShares(total);

    return {
      id: r.id,
      status: r.status,
      address: r.address,
      deal_type: r.deal_type,
      final_price: fromMinor(r.final_price_minor),
      commission_total: fromMinor(total),
      listing_share: fromMinor(shares.listing),
      closing_share: fromMinor(shares.closing),
      listing_agent_name: r.listing_agent_name,
      closing_agent_name: r.closing_agent_name,
      created_at: r.created_at,
      closed_at: r.closed_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Активности
// ---------------------------------------------------------------------------

export type ActivityItem = {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  body: string | null;
  due_at: string | null;
  done: boolean;
  done_at: string | null;
  is_shared: boolean;
  created_at: string;
  agent_id: string;
  agent_name: string | null;
  mine: boolean;
  overdue: boolean;
  entity_title: string | null;
};

/** Заголовок сущности, к которой привязана активность. */
const ENTITY_TITLE = `case a.entity_type
  when 'object'      then (select o.address from objects o where o.id = a.entity_id)
  when 'contact'     then (select c.name from contacts c where c.id = a.entity_id)
  when 'requirement' then (select coalesce(c.name, 'клиент скрыт') from requirements r
                             left join contacts c on c.id = r.contact_id
                            where r.id = a.entity_id)
  when 'deal'        then (select o.address from deals d join objects o on o.id = d.object_id
                            where d.id = a.entity_id)
  when 'match'       then (select o.address from matches mt join objects o on o.id = mt.object_id
                            where mt.id = a.entity_id)
  when 'mandate'     then (select o.address from mandates md join objects o on o.id = md.object_id
                            where md.id = a.entity_id)
end`;

function toActivity(r: Omit<ActivityItem, 'done' | 'is_shared' | 'mine' | 'overdue'> & {
  done: number; is_shared: number; mine: number; overdue: number;
}): ActivityItem {
  return {
    ...r,
    done: r.done === 1,
    is_shared: r.is_shared === 1,
    mine: r.mine === 1,
    overdue: r.overdue === 1,
  };
}

export async function activityFeed(
  entityType: string,
  entityId: string,
): Promise<ActivityItem[]> {
  const me = await asker();
  const at = new Date().toISOString();

  const rows = await all<Parameters<typeof toActivity>[0]>(
    `select a.id, a.kind, a.entity_type, a.entity_id, a.body, a.due_at,
            a.done, a.done_at, a.is_shared, a.created_at, a.agent_id,
            ag.full_name as agent_name,
            (a.agent_id = ?1) as mine,
            (a.done = 0 and a.due_at is not null and a.due_at < ?4) as overdue,
            ${ENTITY_TITLE} as entity_title
       from activities a
       left join agents ag on ag.id = a.agent_id
      where a.entity_type = ?2 and a.entity_id = ?3
      order by coalesce(a.due_at, a.created_at) desc limit 200`,
    me.id, entityType, entityId, at,
  );

  return rows.map(toActivity);
}

/** Личный список задач: свои незакрытые, по сроку. */
export async function myActivities(): Promise<ActivityItem[]> {
  const me = await asker();
  const at = new Date().toISOString();

  const rows = await all<Parameters<typeof toActivity>[0]>(
    `select a.id, a.kind, a.entity_type, a.entity_id, a.body, a.due_at,
            a.done, a.done_at, a.is_shared, a.created_at, a.agent_id,
            ag.full_name as agent_name,
            1 as mine,
            (a.done = 0 and a.due_at is not null and a.due_at < ?2) as overdue,
            ${ENTITY_TITLE} as entity_title
       from activities a
       left join agents ag on ag.id = a.agent_id
      where a.agent_id = ?1 and a.done = 0
      order by a.due_at is null, a.due_at limit 200`,
    me.id, at,
  );

  return rows.map(toActivity);
}

// ---------------------------------------------------------------------------
// Счётчики для главной кабинета
// ---------------------------------------------------------------------------

export async function cabinetCounters() {
  const me = await asker();
  const at = new Date().toISOString();

  return one<{
    objects: number; published: number; requirements: number;
    deals: number; tasks_overdue: number; leads_new: number; requests_new: number;
  }>(
    `select
       (select count(*) from objects o where ${objectEditable('o', me.id, me.admin).sql})
         as objects,
       (select count(*) from objects o where o.publication_state = 'published'
          and ${objectEditable('o', me.id, me.admin).sql}) as published,
       (select count(*) from requirements r where r.agent_id = ?1) as requirements,
       (select count(*) from deals d where ?1 in (d.listing_agent_id, d.closing_agent_id))
         as deals,
       (select count(*) from activities a where a.agent_id = ?1 and a.done = 0
          and a.due_at is not null and a.due_at < ?2) as tasks_overdue,
       (select count(*) from leads l where l.status = 'new'
          and exists (select 1 from objects o where o.id = l.object_id
                        and ${objectEditable('o', me.id, me.admin).sql})) as leads_new,
       (select count(*) from requests rq where rq.status = 'new') as requests_new`,
    me.id, at,
  );
}
