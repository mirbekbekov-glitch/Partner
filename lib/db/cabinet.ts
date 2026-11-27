import 'server-only';
import { all, jsonArray, one } from './sql';
import { requireAgent } from './session';
import { fromMinor } from './money';
import { commissionShares, commissionTotal, parseRule, partnerAmount } from './commission';
import { panoramasFrom } from './panoramas';
import { contactVisible, dealParty, objectEditable } from './visibility';
import { searchText } from './normalize';
import { PAGE_SIZE } from '../list-params';
import { looksLikeSameName, nameKey } from '../contact-match';

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
 * Окно страницы.
 *
 * Числа подставляются в текст запроса, а не параметрами: индексы ?n в этих
 * запросах считаются вручную, и ещё два сдвинули бы всю нумерацию. Оба
 * значения целые и обрезаны по границам, подставить через них нечего.
 *
 * Верхняя граница размера страницы — 5000. Столько берёт выгрузка в CSV:
 * файл должен содержать весь список, а не его первую страницу. Страницы
 * кабинета просят двадцать, и граница защищает не от злого умысла, а от
 * случайного большого числа в адресе: размер приходит из кода, а не из
 * строки запроса.
 */
function limitOffset(page?: number | null, perPage?: number | null) {
  const size = Math.min(Math.max(Math.trunc(perPage ?? PAGE_SIZE) || PAGE_SIZE, 1), 5000);
  const p = Math.min(Math.max(Math.trunc(page ?? 1) || 1, 1), 100_000);
  return `limit ${size} offset ${(p - 1) * size}`;
}

/** Страница списка: сами строки и сколько их всего под фильтром. */
export type Page<T> = { rows: T[]; total: number };

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
 *
 * ТЕКСТОВЫЕ колонки сортируются по нормализованному виду, а не по самому
 * тексту. Причина та же, что у поиска: SQLite сравнивает строки побайтно,
 * и для кириллицы это значит, что ВСЕ заглавные идут перед всеми
 * строчными. Проверено запросом к боевой базе: «Абрамов, Орозов, Яковлев,
 * абрамов, яковлев» — то есть контакт, записанный строчными, уезжает в
 * конец списка после «Яковлева». `collate nocase` не помогает: он тоже
 * знает только латиницу.
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
  page?: number | null,
  role?: string | null,
  perPage?: number | null,
): Promise<Page<ContactListItem>> {
  const me = await asker();
  const visible = contactVisible('c', me.id, me.admin);

  const params: Params = [me.id, ...visible.params.slice(1)];
  let filter = '';

  if (search?.trim()) {
    // По нормализованной колонке, а не по lower(c.name): lower() в SQLite
    // не приводит кириллицу, и поиск «орозов» не находил «Орозов».
    const text = search.trim();
    const digits = text.replace(/\D/g, '');

    // Условие по телефону добавляется ТОЛЬКО когда в запросе есть цифры.
    // Иначе `digits` пусто, шаблон превращается в `%%`, и он совпадает с
    // любым номером — поиск по имени отдавал всех, у кого есть телефон.
    filter = digits
      ? 'and (c.search_text like ?2 or exists (select 1 from contact_phones cp'
        + ' where cp.contact_id = c.id and cp.phone_normalized like ?3))'
      : 'and c.search_text like ?2';

    params.push(`%${searchText(text)}%`);
    if (digits) params.push(`%${digits}%`);
  }

  // Роль — внутри JSON-массива ролей. Отбор здесь, а не на странице: иначе
  // фильтровалась бы только текущая страница, и счётчик врал бы.
  if (role?.trim()) {
    filter += ` and c.roles like ?${params.length + 1}`;
    params.push(`%"${role.trim()}"%`);
  }

  const rows = await all<Omit<ContactListItem, 'roles' | 'mine'> & {
    roles: string; mine: number; total_count: number;
  }>(
    `select c.id, c.kind, c.name, c.telegram, c.source, c.roles, c.note,
            c.created_at, c.owner_agent_id,
            ag.full_name as owner_name,
            count(*) over () as total_count,
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
        // По нормализованной колонке: см. пояснение к orderBy.
        name: 'c.search_text',
        objects: 'objects_count',
        requirements: 'requirements_count',
        source: 'c.source',
      }, 'c.created_at desc', sort, dir)} ${limitOffset(page, perPage)}`,
    ...params,
  );

  return {
    total: rows[0]?.total_count ?? 0,
    rows: rows.map((r) => ({
      ...r,
      roles: jsonArray<string>(r.roles),
      mine: r.mine === 1,
    })),
  };
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

  // Сравнение общее с duplicatesOf — `looksLikeSameName`. Отдельное
  // правило здесь означало бы, что список пар и подсказка на карточке
  // расходятся: в одном месте дубликат есть, в другом нет.
  const mine = await all<{ id: string; name: string }>(
    `select id, name from contacts where owner_agent_id = ?1
      order by name limit ${DUPLICATE_SCAN_LIMIT}`,
    me.id,
  );

  // Перебор только внутри групп по фамилии: без этого на тысяче контактов
  // вышло бы полмиллиона сравнений ради пятидесяти строк.
  const bySurname = new Map<string, Array<{ id: string; name: string }>>();
  for (const c of mine) {
    const key = nameKey(c.name).split(' ')[0] ?? '';
    if (!key) continue;
    const group = bySurname.get(key);
    if (group) group.push(c); else bySurname.set(key, [c]);
  }

  const pairs: Array<{ a_id: string; a_name: string; b_id: string; b_name: string }> = [];
  for (const group of bySurname.values()) {
    for (let i = 0; i < group.length && pairs.length < 50; i++) {
      for (let j = i + 1; j < group.length && pairs.length < 50; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (looksLikeSameName(a.name, b.name)) {
          pairs.push({ a_id: a.id, a_name: a.name, b_id: b.id, b_name: b.name });
        }
      }
    }
  }
  return pairs;
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
  /** Телефон собственника — по тому же правилу видимости, что и имя. */
  owner_phone: string | null;
  /** Снимки объекта: в списке нужен только первый. */
  photos: string[];
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
  /** Сколько получит агент, который приведёт покупателя. */
  partner_amount: number | null;
  /** Названный процент от сделки. Пусто — половина комиссии, по старому правилу. */
  partner_rate: number | null;
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
  page?: number | null;
  perPage?: number | null;
} = {}): Promise<Page<ObjectListItem>> {
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
    Omit<ObjectListItem, 'can_edit' | 'contract_confirmed' | 'commission_total' | 'photos'> & {
      can_edit: number; contract_confirmed: number | null;
      price_minor: number; commission_rule: string | null; partner_rate: number | null;
      total_count: number;
      photos: string;
    }
  >(
    `select o.id, o.kind, o.deal_type, o.address, o.city, o.zone, o.rooms, o.area,
            o.floor, o.price_minor / 100.0 as price, o.currency,
            o.publication_state, o.published_at, o.actual_at, o.created_at,
            m.id as mandate_id,
            coalesce(m.contract_confirmed, 0) as contract_confirmed,
            m.listing_agent_id, m.commission_rule, m.partner_rate,
            la.full_name as listing_agent_name,
            org.name as organization_name,
            ra.full_name as responsible_name,
            -- Порядок по сопоставимому виду, а не по самому имени: см.
            -- пояснение к orderBy.
            ra.name_sort as responsible_sort,
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
            -- Телефон собственника — за тем же условием, что и имя:
            -- инвариант 4 не делает различий между ними, а звонить из
            -- списка нужно чаще, чем открывать карточку.
            (select case when ${visible.sql} then
                      (select cp.phone from contact_phones cp
                        where cp.contact_id = oc.id
                        order by cp.is_primary desc limit 1) end
               from object_ownerships oo
               join contacts oc on oc.id = oo.contact_id
              where oo.object_id = o.id and oo.role = 'owner'
              limit 1) as owner_phone,
            o.photos,
            (${editable.sql}) as can_edit,
            (select count(*) from leads l
              where l.object_id = o.id and l.status = 'new') as leads_new,
            -- Сколько объектов под этим фильтром всего. Окно считается до
            -- limit, поэтому второй запрос за числом не нужен.
            count(*) over () as total_count
       from objects o
       left join mandates m on m.object_id = o.id and m.status = 'active'
       left join agents la on la.id = m.listing_agent_id
       left join agents ra on ra.id = ${responsible}
       left join organizations org on org.id = ra.organization_id
      where ${where.join(' and ')}
      ${orderBy({
        address: 'o.search_text',
        deal: 'o.deal_type',
        state: 'o.publication_state',
        price: 'o.price_minor',
        matches: 'matches_count',
        agent: 'responsible_sort',
        actual: 'o.actual_at',
      }, 'o.actual_at desc', query.sort, query.dir)}
      ${limitOffset(query.page, query.perPage)}`,
    ...params,
  );

  return {
    total: rows[0]?.total_count ?? 0,
    rows: rows.map((r) => ({
    ...r,
    can_edit: r.can_edit === 1,
    contract_confirmed: r.contract_confirmed === 1,
    // Снимки разбираются здесь, а не у вызывающего: в D1 это колонка с
    // текстом, и всякий, кто её читает, обязан разбор сделать.
    photos: jsonArray<string>(r.photos),
    // Комиссия объекта считается на лету от текущей цены по правилу
    // мандата: записывать её некуда и незачем — объект ещё не продан, и
    // записанная сумма означала бы, что деньги уже поделены. Без
    // активного мандата правила нет, и суммы тоже.
    commission_total: fromMinor(
      commissionTotal(r.deal_type, r.price_minor, parseRule(r.commission_rule)),
    ),
    // Комиссия партнёру — то, ради чего в список заглядывает чужой
    // агент: она решает, звонить ему по этому объекту или нет.
    partner_amount: fromMinor(commissionShares(
      commissionTotal(r.deal_type, r.price_minor, parseRule(r.commission_rule)),
      { priceMinor: r.price_minor, rate: r.partner_rate },
    ).closing),
    partner_rate: r.partner_rate,
    })),
  };
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

  const rows = await all<{
    id: string; phone: string; label: string | null; is_primary: number;
  }>(
    `select cp.id, cp.phone, cp.label, cp.is_primary
       from contact_phones cp join contacts c on c.id = cp.contact_id
      where cp.contact_id = ?2 and ${visible.sql}
      order by cp.is_primary desc, cp.created_at`,
    me.id, contactId,
  );

  // 0 и 1 превращаются в признак здесь, как и в остальных запросах: в
  // браузер должно приходить то, что страница объявляет типом.
  return rows.map((r) => ({ ...r, is_primary: r.is_primary === 1 }));
}

/**
 * Кандидаты в дубликаты для конкретной записи.
 *
 * Сравнение живёт в `looksLikeSameName`, а не в запросе, и это не вопрос
 * удобства. `lower()` в SQLite не трогает кириллицу — проверено запросом
 * к боевой базе, `lower('ОРОЗОВ Нурлан')` возвращает строку как есть, —
 * поэтому прежнее `lower(a.name) = lower(b.name)` для русских имён
 * сравнивало С УЧЁТОМ регистра и одного человека, записанного капсом,
 * дубликатом не считало. Плюс «Орозов Н.» на SQL не выразить вовсе.
 *
 * Цена решения: имена своих контактов читаются целиком. Предел в тысячу
 * назван прямо, а не подразумевается: на масштабе агентства этого с
 * запасом хватает, а молчаливое усечение означало бы, что дубликат
 * иногда не находится и никто не знает почему.
 */
const DUPLICATE_SCAN_LIMIT = 1000;

export async function duplicatesOf(contactId: string) {
  const me = await asker();

  const self = await one<{ name: string }>(
    'select name from contacts where id = ? and owner_agent_id = ?',
    contactId, me.id,
  );
  if (!self) return [];

  const mine = await all<{ id: string; name: string }>(
    `select id, name from contacts
      where owner_agent_id = ?1 and id <> ?2
      order by created_at limit ${DUPLICATE_SCAN_LIMIT}`,
    me.id, contactId,
  );

  const hits = mine.filter((c) => looksLikeSameName(self.name, c.name)).slice(0, 20);
  if (hits.length === 0) return [];

  // Владелец проверяется и в выборке имён выше, и в запросе ниже. Это
  // намеренный дубль: снятие одной из двух проверок прогон не валит — и
  // это проверено мутацией, — но каждая из них стоит на пути к чужому
  // телефону, который подтягивается следующим запросом. Одна проверка
  // здесь была бы ровно одной опечаткой до утечки.
  const marks = hits.map(() => '?').join(', ');
  return all<{
    other_id: string; other_name: string;
    other_phones: string | null; other_requirements: number;
  }>(
    `select b.id as other_id, b.name as other_name,
            (select group_concat(cp.phone, ', ') from contact_phones cp
              where cp.contact_id = b.id) as other_phones,
            (select count(*) from requirements r where r.contact_id = b.id)
              as other_requirements
       from contacts b
      where b.id in (${marks}) and b.owner_agent_id = ?
      order by b.created_at`,
    ...hits.map((c) => c.id), me.id,
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
    id: string; kind: string; subkind: string | null;
    deal_type: 'rent' | 'sale'; address: string;
    city: string; zone: string | null; rooms: number | null; area: number | null;
    floor: number | null; floors_total: number | null; price: number;
    currency: string; photos: string; description: string | null;
    publication_state: string; published_at: string | null; actual_at: string;
    created_by_agent_id: string;
    // Поля выгрузки: карточка их показывает и форма правит.
    latitude: number | null; longitude: number | null;
    region: string | null; district: string | null; micro_district: string | null;
    house_number: string | null; building_type: string | null; serie: string | null;
    land_area: number | null; rental_term: string | null;
    commercial_type: string | null; room_location: string | null;
    parking_type: string | null; build_year: number | null;
    panoramas: string | null;
  }>(
    `select o.id, o.kind, o.subkind, o.deal_type, o.address, o.city, o.zone,
            o.rooms, o.area,
            o.floor, o.floors_total, o.price_minor / 100.0 as price, o.currency,
            o.photos, o.description, o.publication_state, o.published_at,
            o.actual_at, o.created_by_agent_id,
            o.latitude, o.longitude, o.region, o.district, o.micro_district,
            o.house_number, o.building_type, o.serie, o.land_area,
            o.rental_term, o.commercial_type, o.room_location, o.parking_type,
            o.build_year, o.panoramas
       from objects o where o.id = ?`,
    id,
  );

  // Панорамы разбираются здесь, как и снимки: в колонке лежит текст, и
  // всякий, кто её читает, обязан разбор сделать.
  return row && {
    ...row,
    photos: jsonArray<string>(row.photos),
    panoramas: panoramasFrom(row.panoramas),
  };
}

/** Активный мандат объекта — для блока договора на карточке. */
export async function activeMandateOf(objectId: string) {
  await asker();
  const row = await one<{
    id: string; kind: string; contract_confirmed: number; valid_to: string | null;
    commission_rule: string | null; partner_rate: number | null;
    price_minor: number; deal_type: 'rent' | 'sale'; currency: string;
  }>(
    `select m.id, m.kind, m.contract_confirmed, m.valid_to,
            m.commission_rule, m.partner_rate,
            o.price_minor, o.deal_type, o.currency
       from mandates m
       join objects o on o.id = m.object_id
      where m.object_id = ? and m.status = 'active'`,
    objectId,
  );
  if (!row) return null;

  // Комиссия считается от ТЕКУЩЕЙ цены: записывать её некуда — объект
  // ещё не продан, и записанная сумма означала бы, что деньги поделены.
  const base = commissionTotal(row.deal_type, row.price_minor, parseRule(row.commission_rule));
  const shares = commissionShares(base, { priceMinor: row.price_minor, rate: row.partner_rate });

  // Процент комиссии для формы: в колонке лежит правило, а человек
  // вводит процент. При аренде правило хранит долю месяца (0.5), а
  // человек пишет проценты (50) — переводим здесь, в одном месте.
  const rule = parseRule(row.commission_rule);
  const commission_percent = rule === null ? null
    : rule.kind === 'percent' ? rule.value
    : rule.kind === 'months_share' ? Math.round(rule.value * 1000) / 10
    : null;

  return {
    ...row,
    // Итог — тот, что сходится с долями: обещано партнёру больше нашей
    // комиссии, и итогом становится обещанное.
    commission_total: fromMinor(shares.total),
    partner_amount: fromMinor(shares.closing),
    commission_percent,
  };
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
    partner_rate: number | null;
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
            o.price_minor, m.commission_rule, m.partner_rate,
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
      : commissionShares(total, { priceMinor: r.price_minor, rate: r.partner_rate });

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
  page?: number | null;
  perPage?: number | null;
} = {}): Promise<Page<RequirementListItem>> {
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
    // По нормализованной колонке — та же причина, что и у контактов.
    where.push(`r.search_text like ?${++n}`);
    params.push(`%${searchText(query.q)}%`);
  }

  if (query.mine) where.push('r.agent_id = ?1');

  const rows = await all<Omit<RequirementListItem, 'zones' | 'rooms' | 'mine'> & {
    zones: string; rooms: string; mine: number; total_count: number;
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
              as deals_count,
            count(*) over () as total_count
       from requirements r
       left join agents ag on ag.id = r.agent_id
      where ${where.join(' and ')}
      ${orderBy({
        budget: 'r.budget_max_minor',
        deal: 'r.deal_type',
        status: 'r.status',
        agent: 'ag.name_sort',
        matches: 'matches_count',
        showings: 'showings_count',
        deadline: 'r.deadline',
      }, 'r.updated_at desc', query.sort, query.dir)}
      ${limitOffset(query.page, query.perPage)}`,
    ...params,
  );

  return {
    total: rows[0]?.total_count ?? 0,
    rows: rows.map((r) => ({
      ...r,
      zones: jsonArray<string>(r.zones),
      rooms: jsonArray<number>(r.rooms),
      mine: r.mine === 1,
    })),
  };
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
    commission_rule: string | null; partner_rate: number | null;
    listing_agent_name: string | null;
    owner_name: string | null; deal_id: string | null; deal_status: string | null;
    deal_total: number | null; deal_listing: number | null; deal_closing: number | null;
    can_lead: number;
  }>(
    `select mt.id as match_id, mt.requirement_id, mt.object_id,
            mt.status as match_status, mt.showing_at, mt.rejection_reason,
            o.address, o.zone, o.rooms, o.area, o.floor,
            o.price_minor / 100.0 as price, o.price_minor, o.currency,
            o.publication_state, o.actual_at, o.deal_type,
            m.id as mandate_id, m.contract_confirmed, m.commission_rule, m.partner_rate,
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
      : commissionShares(total, { priceMinor: r.price_minor, rate: r.partner_rate });

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

/** Какие сделки показывать: идущие или завершённые. */
export type DealScope = 'open' | 'done';

/**
 * Сколько сделок в каждой вкладке.
 *
 * Считает база: подпись вкладки должна показывать всё, а не то, что
 * уместилось на странице.
 */
export async function dealCounts(): Promise<Record<DealScope, number>> {
  const me = await asker();
  const party = dealParty('d', me.id, me.admin);

  const row = await one<{ open: number; done: number }>(
    `select
       sum(case when d.status in ('closed', 'failed') then 0 else 1 end) as open,
       sum(case when d.status in ('closed', 'failed') then 1 else 0 end) as done
     from deals d
     where ${party.sql}`,
    me.id,
  );

  return { open: row?.open ?? 0, done: row?.done ?? 0 };
}

export async function dealList(
  sort?: string | null,
  dir?: 'asc' | 'desc',
  scope: DealScope = 'open',
  page?: number | null,
  perPage?: number | null,
): Promise<Page<DealListItem>> {
  const me = await asker();
  const party = dealParty('d', me.id, me.admin);

  const visible = contactVisible('c', me.id, me.admin);

  const rows = await all<{
    id: string; status: string; address: string; deal_type: 'rent' | 'sale';
    total_count: number;
    final_price_minor: number | null; price_minor: number; currency: string;
    failure_reason: string | null;
    commission_total_minor: number | null;
    listing_share_minor: number | null; closing_share_minor: number | null;
    commission_rule: string | null; partner_rate: number | null;
    listing_agent_name: string | null; closing_agent_name: string | null;
    client_name: string | null; can_act: number;
    created_at: string; closed_at: string | null;
  }>(
    `select d.id, d.status, o.address, o.deal_type,
            d.final_price_minor, o.price_minor, o.currency, m.commission_rule, m.partner_rate,
            d.failure_reason,
            d.commission_total_minor, d.listing_share_minor, d.closing_share_minor,
            la.full_name as listing_agent_name,
            ca.full_name as closing_agent_name,
            (select case when ${visible.sql} then c.name end
               from requirements r join contacts c on c.id = r.contact_id
              where r.id = d.requirement_id) as client_name,
            (${party.sql}) as can_act,
            count(*) over () as total_count,
            d.created_at, d.closed_at
       from deals d
       join objects o on o.id = d.object_id
       join mandates m on m.id = d.mandate_id
       left join agents la on la.id = d.listing_agent_id
       left join agents ca on ca.id = d.closing_agent_id
      where ${party.sql}
        and d.status ${scope === 'done' ? 'in' : 'not in'} ('closed', 'failed')
      ${orderBy({
        address: 'o.search_text',
        status: 'd.status',
        price: 'coalesce(d.final_price_minor, o.price_minor)',
        created: 'd.created_at',
      }, 'd.created_at desc', sort, dir)} ${limitOffset(page, perPage)}`,
    me.id,
  );

  const items = rows.map((r) => {
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
      : commissionShares(total, { priceMinor: r.price_minor, rate: r.partner_rate });

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

  return { total: rows[0]?.total_count ?? 0, rows: items };
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
    commission_rule: string | null; partner_rate: number | null;
    listing_agent_name: string | null; closing_agent_name: string | null;
    commission_total_minor: number | null; listing_share_minor: number | null;
    closing_share_minor: number | null;
    client_name: string | null; owners: string | null; can_act: number;
  }>(
    `select d.id, d.status, d.created_at, d.closed_at, d.final_price_minor,
            d.failure_reason, d.object_id, d.requirement_id, d.match_id,
            d.mandate_id, o.address, o.deal_type, o.zone, o.rooms,
            o.price_minor as object_price_minor, o.currency, m.commission_rule, m.partner_rate,
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
    : commissionShares(total, {
      priceMinor: row.final_price_minor ?? row.object_price_minor, rate: row.partner_rate,
    });

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
/** Какие дела показывать: просроченные, со сроком впереди или без срока. */
export type ActivityScope = 'overdue' | 'due' | 'nodate';

const ACTIVITY_SCOPE: Record<ActivityScope, string> = {
  overdue: 'a.due_at is not null and a.due_at < ?2',
  due: 'a.due_at is not null and a.due_at >= ?2',
  nodate: 'a.due_at is null',
};

/**
 * Личный список дел одной вкладкой.
 *
 * Раньше страница брала двести незакрытых записей и делила их на разделы
 * уже в браузере. Пока записей мало, разница незаметна; на двести первой
 * просроченная задача просто перестала бы показываться — молча.
 *
 * Поэтому разделы стали вкладками: условие ушло в запрос, и каждая
 * вкладка листается своими страницами.
 */
export async function myActivities(
  scope: ActivityScope = 'overdue',
  page?: number | null,
  perPage?: number | null,
): Promise<Page<ActivityItem>> {
  const me = await asker();
  const at = new Date().toISOString();

  const rows = await all<Parameters<typeof toActivity>[0] & { total_count: number }>(
    `select a.id, a.kind, a.entity_type, a.entity_id, a.body, a.due_at,
            a.done, a.done_at, a.is_shared, a.created_at, a.agent_id,
            ag.full_name as agent_name,
            1 as mine,
            (a.done = 0 and a.due_at is not null and a.due_at < ?2) as overdue,
            ${ENTITY_TITLE} as entity_title,
            count(*) over () as total_count
       from activities a
       left join agents ag on ag.id = a.agent_id
      where a.agent_id = ?1 and a.done = 0
        and ${ACTIVITY_SCOPE[scope] ?? ACTIVITY_SCOPE.overdue}
      order by a.due_at is null, a.due_at ${limitOffset(page, perPage)}`,
    me.id, at,
  );

  return { total: rows[0]?.total_count ?? 0, rows: rows.map(toActivity) };
}

/**
 * Сколько дел в каждой вкладке.
 *
 * Одним запросом и в базе: подписи вкладок должны показывать всё, а не то,
 * что уместилось на странице. Просроченное число — главное на экране, и
 * врать ему нельзя.
 */
export async function myActivityCounts(): Promise<Record<ActivityScope, number>> {
  const me = await asker();
  const at = new Date().toISOString();

  const row = await one<{ overdue: number; due: number; nodate: number }>(
    `select
       sum(case when a.due_at is not null and a.due_at < ?2 then 1 else 0 end) as overdue,
       sum(case when a.due_at is not null and a.due_at >= ?2 then 1 else 0 end) as due,
       sum(case when a.due_at is null then 1 else 0 end) as nodate
     from activities a
     where a.agent_id = ?1 and a.done = 0`,
    me.id, at,
  );

  return {
    overdue: row?.overdue ?? 0,
    due: row?.due ?? 0,
    nodate: row?.nodate ?? 0,
  };
}

/**
 * Последние записи агента — для главной кабинета.
 *
 * Это лента ТОГО, ЧТО УЖЕ СЛУЧИЛОСЬ: закрытые записи плюс заметки и
 * сообщения, которые не закрывают вовсе. Незакрытые задачи и показы сюда
 * не попадают намеренно — они стоят выше, в списке дел, и в ленте
 * повторялись бы строка в строку.
 *
 * Порядок по тому, когда запись закрыли или завели, а не по сроку:
 * «сегодня закрыл показ» важнее, чем «когда-то назначил звонок».
 *
 * Только свои: чужие активности видит карточка сущности, и мешать их в
 * личную ленту значило бы показывать на главной чужую работу.
 */
export async function recentActivity(limit = 6): Promise<ActivityItem[]> {
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
      where a.agent_id = ?1
        and (a.done = 1 or a.kind in ('note', 'message'))
      order by coalesce(a.done_at, a.updated_at, a.created_at) desc
      limit ?3`,
    me.id, at, limit,
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
export type LeadFeedItem = {
  id: string; object_id: string; name: string; phone: string;
  message: string | null; status: string; created_at: string;
  agent_id: string | null; address: string | null; agent_name: string | null;
};

export async function leadFeed(
  status?: string | null,
  page?: number | null,
): Promise<Page<LeadFeedItem>> {
  const me = await asker();
  const editable = objectEditable('o', me.id, me.admin);

  const params: Params = [me.id];
  let filter = '';
  if (status) { filter = 'and l.status = ?2'; params.push(status); }

  const rows = await all<LeadFeedItem & { total_count: number }>(
    `select l.id, l.object_id, l.name, l.phone, l.message, l.status,
            l.created_at, l.agent_id,
            o.address, ag.full_name as agent_name,
            count(*) over () as total_count
       from leads l
       join objects o on o.id = l.object_id
       left join agents ag on ag.id = l.agent_id
      where ${editable.sql} ${filter}
      order by l.created_at desc ${limitOffset(page)}`,
    ...params,
  );

  return { total: rows[0]?.total_count ?? 0, rows };
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
