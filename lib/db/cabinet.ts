import 'server-only';
import { all, jsonArray, one } from './sql';
import { requireAgent } from './session';
import { fromMinor } from './money';
import { commissionShares, commissionTotal, parseRule } from './commission';
import { contactVisible, dealParty, objectEditable } from './visibility';
import { searchText } from './normalize';

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


/**
 * Порядок строк списка.
 *
 * Белый список колонок — единственное место, где имя из адреса
 * превращается в SQL. Неизвестное имя молча заменяется порядком по
 * умолчанию: подставить в запрос то, что пришло из браузера, нельзя.
 *
 * Колонки, закрытые инвариантом 4 (имя собственника, имя клиента), в
 * списки не входят намеренно: порядок строк выдал бы то, что скрыто в
 * самой ячейке.
 */
function orderBy(
  columns: Record<string, string>,
  fallback: string,
  sort?: string | null,
  dir?: 'asc' | 'desc',
) {
  const col = sort && Object.prototype.hasOwnProperty.call(columns, sort)
    ? columns[sort]
    : null;
  if (!col) return `order by ${fallback}`;
  return `order by ${col} ${dir === 'asc' ? 'asc' : 'desc'}`;
}

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

export async function contactList(
  search?: string | null,
  sort?: string | null,
  dir?: 'asc' | 'desc',
): Promise<ContactListItem[]> {
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
      ${orderBy({
        name: 'c.name',
        objects: 'objects_count',
        requirements: 'requirements_count',
        source: 'c.source',
      }, 'c.created_at desc', sort, dir)} limit 200`,
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
  /** Кто ведёт объект: listing-агент активного мандата, иначе — автор. */
  responsible_name: string | null;
  responsible_org_name: string | null;
  /** Подборов по объекту. */
  matches_count: number;
  /** Комиссия по правилу мандата от текущей цены. Всегда индикативна. */
  commission_total: number | null;
  can_edit: boolean;
  leads_new: number;
};

export type ObjectSource = 'mine' | 'org' | 'others' | 'all';

export async function objectList(query: {
  state?: string | null;
  deal?: string | null;
  zone?: string | null;
  q?: string | null;
  source?: ObjectSource;
  agentId?: string | null;
  sort?: string | null;
  dir?: 'asc' | 'desc';
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
  if (query.zone)  { where.push(`o.zone = ${next()}`); params.push(query.zone); }

  // Поиск по адресу — по той же нормализованной колонке, что и в каталоге:
  // lower() в SQLite не трогает кириллицу вовсе.
  if (query.q?.trim()) {
    where.push(`o.search_text like ${next()}`);
    params.push(`%${searchText(query.q)}%`);
  }

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

  const rows = await all<
    Omit<ObjectListItem, 'can_edit' | 'contract_confirmed' | 'commission_total'> & {
      can_edit: number; contract_confirmed: number | null;
      price_minor: number; commission_rule: string | null;
    }
  >(
    `select o.id, o.kind, o.deal_type, o.address, o.city, o.zone, o.rooms, o.area,
            o.floor, o.price_minor / 100.0 as price, o.currency,
            o.publication_state, o.published_at, o.actual_at, o.created_at,
            m.id as mandate_id,
            coalesce(m.contract_confirmed, 0) as contract_confirmed,
            m.listing_agent_id, m.commission_rule,
            la.full_name as listing_agent_name,
            org.name as organization_name,
            ra.full_name as responsible_name,
            org.name as responsible_org_name,
            o.price_minor,
            (select count(*) from matches mt where mt.object_id = o.id)
              as matches_count,
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
      ${orderBy({
        address: 'o.address',
        deal: 'o.deal_type',
        state: 'o.publication_state',
        price: 'o.price_minor',
        matches: 'matches_count',
        agent: 'responsible_name',
        actual: 'o.actual_at',
      }, 'o.actual_at desc', query.sort, query.dir)} limit 200`,
    ...params,
  );

  return rows.map((r) => ({
    ...r,
    can_edit: r.can_edit === 1,
    contract_confirmed: r.contract_confirmed === 1,
    // Комиссия объекта считается на лету от текущей цены по правилу
    // мандата: записывать её некуда и незачем — объект ещё не продан, и
    // записанная сумма означала бы, что деньги уже поделены. Без
    // активного мандата правила нет, и суммы тоже.
    commission_total: fromMinor(
      commissionTotal(r.deal_type, r.price_minor, parseRule(r.commission_rule)),
    ),
  }));
}

/** Одна карточка контакта — с той же видимостью, что и список. */
export async function contactCard(id: string): Promise<ContactListItem | null> {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const row = await one<Omit<ContactListItem, 'roles' | 'mine'> & {
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
      where c.id = ?2 and ${visible.sql}`,
    me.id, id,
  );

  return row && {
    ...row,
    roles: jsonArray<string>(row.roles),
    mine: row.mine === 1,
  };
}

/**
 * Телефоны контакта.
 *
 * Отдаются только тому, кому инвариант 4 открывает сам контакт: условие
 * стоит в запросе, а не проверяется страницей.
 */
export async function contactPhoneList(contactId: string) {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  return all<{ id: string; phone: string; label: string | null; is_primary: number }>(
    `select cp.id, cp.phone, cp.label, cp.is_primary
       from contact_phones cp join contacts c on c.id = cp.contact_id
      where cp.contact_id = ?2 and ${visible.sql}
      order by cp.is_primary desc, cp.created_at`,
    me.id, contactId,
  );
}

/** Пара дубликатов для конкретной записи. */
export async function duplicatesOf(contactId: string) {
  const me = await asker();

  return all<{
    other_id: string; other_name: string;
    other_phones: string | null; other_requirements: number;
  }>(
    `select b.id as other_id, b.name as other_name,
            (select group_concat(cp.phone, ', ') from contact_phones cp
              where cp.contact_id = b.id) as other_phones,
            (select count(*) from requirements r where r.contact_id = b.id)
              as other_requirements
       from contacts a join contacts b
         on lower(trim(a.name)) = lower(trim(b.name)) and a.id <> b.id
      where a.id = ?2 and a.owner_agent_id = ?1 and b.owner_agent_id = ?1
      limit 20`,
    me.id, contactId,
  );
}

/** Объекты, за которые агент отвечает: предлагать чужие бессмысленно. */
export async function linkableObjects() {
  const me = await asker();
  const editable = objectEditable('o', me.id, me.admin);

  return all<{
    id: string; address: string; deal_type: string; price: number; currency: string;
  }>(
    `select o.id, o.address, o.deal_type,
            o.price_minor / 100.0 as price, o.currency
       from objects o where ${editable.sql} order by o.address limit 200`,
    me.id,
  );
}

/**
 * Карточка объекта для кабинета: цена в основных единицах, снимки списком.
 *
 * Снимки РАЗБИРАЮТСЯ здесь, а не у вызывающего. В D1 колонка `photos` —
 * это текст с JSON, тогда как Postgres отдавал `jsonb` уже разобранным.
 * При переезде разница осталась незамеченной, потому что страница правки
 * приводила ответ к нужному типу через `as unknown as`: приведение
 * заглушило проверку типов, и страница падала на любом объекте уже в
 * браузере — «.map is not a function».
 *
 * Разбор именно здесь, рядом с запросом: то же самое делают objectView и
 * витрина, и всякий, кто читает `photos` из базы, обязан его сделать.
 * Отдавать наружу сырую строку значит ждать, что об этом вспомнит каждый
 * вызывающий — один уже не вспомнил.
 */
export async function objectCard(id: string) {
  await asker();
  const row = await one<{
    id: string; kind: string; deal_type: 'rent' | 'sale'; address: string;
    city: string; zone: string | null; rooms: number | null; area: number | null;
    floor: number | null; floors_total: number | null; price: number;
    currency: string; photos: string; description: string | null;
    publication_state: string; published_at: string | null; actual_at: string;
    created_by_agent_id: string;
  }>(
    `select o.id, o.kind, o.deal_type, o.address, o.city, o.zone, o.rooms, o.area,
            o.floor, o.floors_total, o.price_minor / 100.0 as price, o.currency,
            o.photos, o.description, o.publication_state, o.published_at,
            o.actual_at, o.created_by_agent_id
       from objects o where o.id = ?`,
    id,
  );

  return row && { ...row, photos: jsonArray<string>(row.photos) };
}

/** Активный мандат объекта — для блока договора на карточке. */
export async function activeMandateOf(objectId: string) {
  await asker();
  return one<{
    id: string; kind: string; contract_confirmed: number; valid_to: string | null;
  }>(
    `select id, kind, contract_confirmed, valid_to from mandates
      where object_id = ? and status = 'active'`,
    objectId,
  );
}

/**
 * Подборы по объекту.
 *
 * Имя клиента закрыто инвариантом 4, комиссия считается на лету до
 * закрытия сделки. can_lead отвечает на вопрос «показывать ли кнопки
 * ведения» — и считается здесь, а не на странице: правило одно, а страниц
 * с подборами две.
 */
export async function objectMatches(objectId: string) {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const rows = await all<{
    match_id: string; object_id: string; requirement_id: string;
    match_status: string; showing_at: string | null;
    rejection_reason: string | null; closing_agent_name: string | null;
    deal_type: 'rent' | 'sale'; budget_min: number | null; budget_max: number | null;
    zones: string; rooms_wanted: string; requirement_status: string;
    client_name: string | null; price_minor: number; commission_rule: string | null;
    deal_id: string | null; deal_status: string | null;
    deal_total: number | null; deal_listing: number | null; deal_closing: number | null;
    can_lead: number;
  }>(
    `select mt.id as match_id, mt.object_id, mt.requirement_id,
            mt.status as match_status, mt.showing_at, mt.rejection_reason,
            ca.full_name as closing_agent_name,
            r.deal_type,
            r.budget_min_minor / 100.0 as budget_min,
            r.budget_max_minor / 100.0 as budget_max,
            r.zones, r.rooms as rooms_wanted, r.status as requirement_status,
            (select case when ${visible.sql} then c.name end
               from contacts c where c.id = r.contact_id) as client_name,
            o.price_minor, m.commission_rule,
            d.id as deal_id, d.status as deal_status,
            d.commission_total_minor as deal_total,
            d.listing_share_minor as deal_listing,
            d.closing_share_minor as deal_closing,
            (mt.closing_agent_id = ?1 or mt.created_by_agent_id = ?1
             or r.agent_id = ?1) as can_lead
       from matches mt
       join requirements r on r.id = mt.requirement_id
       join objects o on o.id = mt.object_id
       left join mandates m on m.object_id = o.id and m.status = 'active'
       left join agents ca on ca.id = mt.closing_agent_id
       left join deals d on d.match_id = mt.id
      where mt.object_id = ?2
      order by mt.created_at desc`,
    me.id, objectId,
  );

  return rows.map((r) => {
    const fixed = r.deal_total !== null;
    const total = fixed
      ? r.deal_total
      : commissionTotal(r.deal_type, r.price_minor, parseRule(r.commission_rule));
    const shares = fixed
      ? { listing: r.deal_listing, closing: r.deal_closing }
      : commissionShares(total);

    return {
      ...r,
      zones: jsonArray<string>(r.zones),
      rooms_wanted: jsonArray<number>(r.rooms_wanted),
      commission_total: fromMinor(total),
      listing_share: fromMinor(shares.listing),
      closing_share: fromMinor(shares.closing),
      can_lead: r.can_lead === 1,
    };
  });
}

/** Открытые потребности — для кнопки «создать подбор». */
export async function openRequirements(dealType?: string | null) {
  await asker();
  const params: Params = [];
  let filter = '';
  if (dealType) { filter = 'and r.deal_type = ?1'; params.push(dealType); }

  return all<{
    id: string; deal_type: string; budget_min: number | null;
    budget_max: number | null; zones: string;
  }>(
    `select r.id, r.deal_type,
            r.budget_min_minor / 100.0 as budget_min,
            r.budget_max_minor / 100.0 as budget_max,
            r.zones
       from requirements r
      where r.status not in ('closed', 'lost') ${filter}
      order by r.created_at desc limit 200`,
    ...params,
  );
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
  updated_at: string;
  requirements_text: string | null;
  agent_id: string;
  agent_name: string | null;
  client_name: string | null;
  mine: boolean;
  matches_count: number;
  /** Состоявшиеся показы: подборы, доведённые до showing_done. */
  showings_count: number;
  /** Сделки, выросшие из этой потребности. */
  deals_count: number;
};

export async function requirementList(query: {
  status?: string | null;
  deal?: string | null;
  zone?: string | null;
  q?: string | null;
  mine?: boolean;
  sort?: string | null;
  dir?: 'asc' | 'desc';
} = {}): Promise<RequirementListItem[]> {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const params: Params = [me.id];
  const where: string[] = ['1 = 1'];
  let n = 1;

  if (query.status) { where.push(`r.status = ?${++n}`); params.push(query.status); }
  if (query.deal)   { where.push(`r.deal_type = ?${++n}`); params.push(query.deal); }

  // Район — внутри JSON-массива зон. like по тексту массива: зон у
  // потребности единицы, и отдельная таблица ради этого не окупается.
  if (query.zone)   { where.push(`r.zones like ?${++n}`); params.push(`%"${query.zone}"%`); }

  if (query.q?.trim()) {
    where.push(`lower(coalesce(r.requirements_text, '')) like ?${++n}`);
    params.push(`%${query.q.trim().toLowerCase()}%`);
  }

  if (query.mine) where.push('r.agent_id = ?1');

  const rows = await all<Omit<RequirementListItem, 'zones' | 'rooms' | 'mine'> & {
    zones: string; rooms: string; mine: number;
  }>(
    `select r.id, r.deal_type,
            r.budget_min_minor / 100.0 as budget_min,
            r.budget_max_minor / 100.0 as budget_max,
            r.zones, r.rooms, r.deadline, r.status, r.created_at, r.updated_at,
            r.requirements_text,
            r.agent_id, ag.full_name as agent_name,
            (r.agent_id = ?1) as mine,
            -- Имя клиента — только тому, кому инвариант 4 его открывает.
            (select case when ${visible.sql} then c.name end
               from contacts c where c.id = r.contact_id) as client_name,
            (select count(*) from matches mt where mt.requirement_id = r.id)
              as matches_count,
            (select count(*) from matches mt where mt.requirement_id = r.id
               and mt.status = 'showing_done') as showings_count,
            (select count(*) from deals dl where dl.requirement_id = r.id)
              as deals_count
       from requirements r
       left join agents ag on ag.id = r.agent_id
      where ${where.join(' and ')}
      ${orderBy({
        budget: 'r.budget_max_minor',
        deal: 'r.deal_type',
        status: 'r.status',
        agent: 'ag.full_name',
        matches: 'matches_count',
        showings: 'showings_count',
        deadline: 'r.deadline',
      }, 'r.updated_at desc', query.sort, query.dir)} limit 200`,
    ...params,
  );

  return rows.map((r) => ({
    ...r,
    zones: jsonArray<string>(r.zones),
    rooms: jsonArray<number>(r.rooms),
    mine: r.mine === 1,
  }));
}

/** Карточка потребности: бюджет в основных единицах, клиент по инварианту 4. */
export async function requirementCard(id: string) {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const row = await one<{
    id: string; contact_id: string; deal_type: 'rent' | 'sale';
    budget_min: number | null; budget_max: number | null;
    zones: string; rooms: string; deadline: string | null;
    requirements_text: string | null; agent_id: string; status: string;
    closed_reason: string | null; created_at: string; updated_at: string;
    client_name: string | null; agent_name: string | null;
  }>(
    `select r.id, r.contact_id, r.deal_type,
            r.budget_min_minor / 100.0 as budget_min,
            r.budget_max_minor / 100.0 as budget_max,
            r.zones, r.rooms, r.deadline, r.requirements_text, r.agent_id,
            r.status, r.closed_reason, r.created_at, r.updated_at,
            ag.full_name as agent_name,
            (select case when ${visible.sql} then c.name end
               from contacts c where c.id = r.contact_id) as client_name
       from requirements r
       left join agents ag on ag.id = r.agent_id
      where r.id = ?2`,
    me.id, id,
  );

  return row && {
    ...row,
    zones: jsonArray<string>(row.zones),
    rooms: jsonArray<number>(row.rooms),
  };
}

/** Подборы по потребности. Зеркало objectMatches, с объектом вместо клиента. */
export async function requirementMatches(requirementId: string) {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const rows = await all<{
    match_id: string; requirement_id: string; object_id: string;
    match_status: string; showing_at: string | null;
    rejection_reason: string | null; address: string; zone: string | null;
    rooms: number | null; area: number | null; floor: number | null;
    price: number; price_minor: number; currency: string;
    publication_state: string; actual_at: string; deal_type: 'rent' | 'sale';
    mandate_id: string | null; contract_confirmed: number | null;
    commission_rule: string | null; listing_agent_name: string | null;
    owner_name: string | null; deal_id: string | null; deal_status: string | null;
    deal_total: number | null; deal_listing: number | null; deal_closing: number | null;
    can_lead: number;
  }>(
    `select mt.id as match_id, mt.requirement_id, mt.object_id,
            mt.status as match_status, mt.showing_at, mt.rejection_reason,
            o.address, o.zone, o.rooms, o.area, o.floor,
            o.price_minor / 100.0 as price, o.price_minor, o.currency,
            o.publication_state, o.actual_at, o.deal_type,
            m.id as mandate_id, m.contract_confirmed, m.commission_rule,
            la.full_name as listing_agent_name,
            (select case when ${visible.sql} then c.name end
               from object_ownerships oo join contacts c on c.id = oo.contact_id
              where oo.object_id = o.id and oo.role = 'owner' limit 1) as owner_name,
            d.id as deal_id, d.status as deal_status,
            d.commission_total_minor as deal_total,
            d.listing_share_minor as deal_listing,
            d.closing_share_minor as deal_closing,
            (mt.closing_agent_id = ?1 or mt.created_by_agent_id = ?1
             or r.agent_id = ?1) as can_lead
       from matches mt
       join objects o on o.id = mt.object_id
       join requirements r on r.id = mt.requirement_id
       left join mandates m on m.object_id = o.id and m.status = 'active'
       left join agents la on la.id = m.listing_agent_id
       left join deals d on d.match_id = mt.id
      where mt.requirement_id = ?2
      order by mt.created_at desc`,
    me.id, requirementId,
  );

  return rows.map((r) => {
    const fixed = r.deal_total !== null;
    const total = fixed
      ? r.deal_total
      : commissionTotal(r.deal_type, r.price_minor, parseRule(r.commission_rule));
    const shares = fixed
      ? { listing: r.deal_listing, closing: r.deal_closing }
      : commissionShares(total);

    return {
      ...r,
      contract_confirmed: r.contract_confirmed === 1,
      commission_total: fromMinor(total),
      listing_share: fromMinor(shares.listing),
      closing_share: fromMinor(shares.closing),
      can_lead: r.can_lead === 1,
    };
  });
}

/** Опубликованные объекты, подходящие потребности, — для кнопки подбора. */
export async function matchableObjects(dealType: string) {
  await asker();
  return all<{
    id: string; address: string; zone: string | null; rooms: number | null;
    price: number; currency: string;
  }>(
    `select o.id, o.address, o.zone, o.rooms,
            o.price_minor / 100.0 as price, o.currency
       from objects o
      where o.deal_type = ? and o.publication_state <> 'withdrawn'
      order by o.actual_at desc limit 200`,
    dealType,
  );
}

// ---------------------------------------------------------------------------
// Сделки
// ---------------------------------------------------------------------------

export type DealListItem = {
  id: string;
  status: string;
  address: string;
  deal_type: 'rent' | 'sale';
  object_price: number;
  currency: string;
  final_price: number | null;
  failure_reason: string | null;
  /** Имя клиента — только тому, кому инвариант 4 его открывает. */
  client_name: string | null;
  /** Участник ли спрашивающий: смотреть сделку можно, менять — не всем. */
  can_act: boolean;
  /** Суммы посчитаны на лету, а не зафиксированы при закрытии. */
  is_indicative: boolean;
  commission_total: number | null;
  listing_share: number | null;
  closing_share: number | null;
  listing_agent_name: string | null;
  closing_agent_name: string | null;
  created_at: string;
  closed_at: string | null;
};

export async function dealList(
  sort?: string | null,
  dir?: 'asc' | 'desc',
): Promise<DealListItem[]> {
  const me = await asker();
  const party = dealParty('d', me.id, me.admin);

  const visible = contactVisible('c', me.id, me.admin);

  const rows = await all<{
    id: string; status: string; address: string; deal_type: 'rent' | 'sale';
    final_price_minor: number | null; price_minor: number; currency: string;
    failure_reason: string | null;
    commission_total_minor: number | null;
    listing_share_minor: number | null; closing_share_minor: number | null;
    commission_rule: string | null;
    listing_agent_name: string | null; closing_agent_name: string | null;
    client_name: string | null; can_act: number;
    created_at: string; closed_at: string | null;
  }>(
    `select d.id, d.status, o.address, o.deal_type,
            d.final_price_minor, o.price_minor, o.currency, m.commission_rule,
            d.failure_reason,
            d.commission_total_minor, d.listing_share_minor, d.closing_share_minor,
            la.full_name as listing_agent_name,
            ca.full_name as closing_agent_name,
            (select case when ${visible.sql} then c.name end
               from requirements r join contacts c on c.id = r.contact_id
              where r.id = d.requirement_id) as client_name,
            (${party.sql}) as can_act,
            d.created_at, d.closed_at
       from deals d
       join objects o on o.id = d.object_id
       join mandates m on m.id = d.mandate_id
       left join agents la on la.id = d.listing_agent_id
       left join agents ca on ca.id = d.closing_agent_id
      where ${party.sql}
      ${orderBy({
        address: 'o.address',
        status: 'd.status',
        price: 'coalesce(d.final_price_minor, o.price_minor)',
        created: 'd.created_at',
      }, 'd.created_at desc', sort, dir)} limit 200`,
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
      object_price: fromMinor(r.price_minor) ?? 0,
      currency: r.currency,
      failure_reason: r.failure_reason,
      client_name: r.client_name,
      can_act: r.can_act === 1,
      is_indicative: !fixed,
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

/**
 * Карточка сделки.
 *
 * Видят только стороны. Суммы: до закрытия индикативные и считаются на
 * лету, после закрытия — зафиксированные. is_indicative говорит странице,
 * какие именно она показывает: иначе агент не отличит «посчитали» от
 * «договорились».
 */
export async function dealCard(id: string) {
  const me = await asker();
  const party = dealParty('d', me.id, me.admin);
  const visible = contactVisible('c', me.id, me.admin);

  const row = await one<{
    id: string; status: string; created_at: string; closed_at: string | null;
    final_price_minor: number | null; failure_reason: string | null;
    object_id: string; requirement_id: string; match_id: string; mandate_id: string;
    address: string; deal_type: 'rent' | 'sale'; zone: string | null;
    rooms: number | null; object_price_minor: number; currency: string;
    commission_rule: string | null;
    listing_agent_name: string | null; closing_agent_name: string | null;
    commission_total_minor: number | null; listing_share_minor: number | null;
    closing_share_minor: number | null;
    client_name: string | null; owners: string | null; can_act: number;
  }>(
    `select d.id, d.status, d.created_at, d.closed_at, d.final_price_minor,
            d.failure_reason, d.object_id, d.requirement_id, d.match_id,
            d.mandate_id, o.address, o.deal_type, o.zone, o.rooms,
            o.price_minor as object_price_minor, o.currency, m.commission_rule,
            la.full_name as listing_agent_name,
            ca.full_name as closing_agent_name,
            d.commission_total_minor, d.listing_share_minor, d.closing_share_minor,
            (select case when ${visible.sql} then c.name end
               from requirements r join contacts c on c.id = r.contact_id
              where r.id = d.requirement_id) as client_name,
            (select group_concat(case when ${visible.sql} then c.name end, ', ')
               from object_ownerships oo join contacts c on c.id = oo.contact_id
              where oo.object_id = d.object_id) as owners,
            (${party.sql}) as can_act
       from deals d
       join objects o on o.id = d.object_id
       join mandates m on m.id = d.mandate_id
       left join agents la on la.id = d.listing_agent_id
       left join agents ca on ca.id = d.closing_agent_id
      where d.id = ?2 and ${party.sql}`,
    me.id, id,
  );
  if (!row) return null;

  const fixed = row.commission_total_minor !== null;
  const total = fixed
    ? row.commission_total_minor
    : commissionTotal(row.deal_type, row.final_price_minor ?? row.object_price_minor,
                      parseRule(row.commission_rule));
  const shares = fixed
    ? { listing: row.listing_share_minor, closing: row.closing_share_minor }
    : commissionShares(total);

  return {
    ...row,
    final_price: fromMinor(row.final_price_minor),
    object_price: fromMinor(row.object_price_minor) ?? 0,
    commission_total: fromMinor(total),
    listing_share: fromMinor(shares.listing),
    closing_share: fromMinor(shares.closing),
    is_indicative: !fixed,
    can_act: row.can_act === 1,
  };
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

/**
 * Числа для главной кабинета.
 *
 * Все одним запросом, а не девятью: девять обращений к базе ради девяти
 * чисел — это девять раз по кругу, и страница ощутимо ждёт.
 *
 * Считается СВОЁ, а не всё подряд: видимость здесь такая же, как в
 * списках, иначе плитка обещала бы объекты, которых агент не увидит.
 */
export async function cabinetCounters() {
  const me = await asker();
  const at = new Date().toISOString();
  const editable = objectEditable('o', me.id, me.admin).sql;
  const visible = contactVisible('c', me.id, me.admin).sql;

  return one<{
    objects: number; published: number; need_mandate: number;
    contacts: number; requirements: number; open_requirements: number;
    matches: number; open_deals: number; tasks_overdue: number;
    leads_new: number; requests_new: number;
  }>(
    `select
       (select count(*) from objects o where ${editable}) as objects,
       (select count(*) from objects o
         where o.publication_state = 'published' and ${editable}) as published,
       -- Объект без активного мандата опубликовать нельзя (инвариант 1),
       -- поэтому это не статистика, а список дел.
       (select count(*) from objects o
         where ${editable}
           and not exists (select 1 from mandates m
                            where m.object_id = o.id and m.status = 'active'))
         as need_mandate,
       (select count(*) from contacts c where ${visible}) as contacts,
       (select count(*) from requirements r where r.agent_id = ?1) as requirements,
       (select count(*) from requirements r
         where r.agent_id = ?1 and r.status not in ('closed', 'lost'))
         as open_requirements,
       (select count(*) from matches mt
         where mt.closing_agent_id = ?1 or mt.created_by_agent_id = ?1) as matches,
       (select count(*) from deals d
         where ?1 in (d.listing_agent_id, d.closing_agent_id)
           and d.status not in ('closed', 'failed')) as open_deals,
       (select count(*) from activities a
         where a.agent_id = ?1 and a.done = 0
           and a.due_at is not null and a.due_at < ?2) as tasks_overdue,
       (select count(*) from leads l
         where l.status = 'new'
           and exists (select 1 from objects o where o.id = l.object_id
                        and ${editable})) as leads_new,
       (select count(*) from requests rq where rq.status = 'new') as requests_new`,
    me.id, at,
  );
}

/**
 * Заявки по объектам агента.
 *
 * Видимость — тем же предикатом, что и правка объекта: иначе вышло бы, что
 * снять объект с публикации агент может, а читать телефоны его заявителей
 * нет.
 */
export async function leadFeed(status?: string | null): Promise<Array<{
  id: string; object_id: string; name: string; phone: string;
  message: string | null; status: string; created_at: string;
  agent_id: string | null; address: string | null; agent_name: string | null;
}>> {
  const me = await asker();
  const editable = objectEditable('o', me.id, me.admin);

  const params: Params = [me.id];
  let filter = '';
  if (status) { filter = 'and l.status = ?2'; params.push(status); }

  return all(
    `select l.id, l.object_id, l.name, l.phone, l.message, l.status,
            l.created_at, l.agent_id,
            o.address, ag.full_name as agent_name
       from leads l
       join objects o on o.id = l.object_id
       left join agents ag on ag.id = l.agent_id
      where ${editable.sql} ${filter}
      order by l.created_at desc limit 100`,
    ...params,
  );
}

/** Напоминания агента — для страницы задач. */
export async function myReminders(): Promise<Array<{
  activity_id: string; kind: string; status: string;
  channel: string | null; last_error: string | null;
}>> {
  const me = await asker();
  return all(
    `select activity_id, kind, status, channel, last_error
       from notifications where agent_id = ?1 order by created_at desc limit 200`,
    me.id,
  );
}
