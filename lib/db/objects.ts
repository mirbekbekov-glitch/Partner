import 'server-only';
import { all, batch, flag, jsonArray, newId, now, one, stmt, toJson } from './sql';
import { auditStmt, diffOf } from './audit';
import { requireAgent } from './session';
import { canEditObject } from './access';
import { normalizePhone } from './normalize';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Объекты — инварианты 1 и 5.
 *
 * Инвариант 1: публиковать можно только при активном мандате.
 * Инвариант 5: правка цены или фото поднимает actual_at; published_at
 * ставится один раз и не меняется никогда.
 *
 * В Postgres второе держал триггер before update, и обойти его не мог даже
 * прямой UPDATE. Здесь триггеров нет, поэтому правило живёт в одном месте —
 * stampTimestamps() ниже — и через него проходит КАЖДАЯ запись в objects.
 * Отдельного UPDATE objects в проекте быть не должно: он обойдёт инвариант.
 */

export type ObjectRow = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price_minor: number;
  currency: string;
  photos: string;
  description: string | null;
  source: string | null;
  publication_state: 'draft' | 'published' | 'withdrawn';
  published_at: string | null;
  actual_at: string;
  created_by_agent_id: string;
  created_at: string;
  updated_at: string;
};

/** Объект с разобранными фотографиями — то, что отдаётся страницам. */
export type ObjectView = Omit<ObjectRow, 'photos'> & { photos: string[] };

function view(row: ObjectRow): ObjectView {
  return { ...row, photos: jsonArray<string>(row.photos) };
}

/** Идентификатор активного мандата объекта — или ничего. */
export async function activeMandateId(objectId: string): Promise<string | null> {
  const row = await one<{ id: string }>(
    `select id from mandates where object_id = ? and status = 'active'`,
    objectId,
  );
  return row?.id ?? null;
}

export async function getObject(id: string): Promise<ObjectView | null> {
  const row = await one<ObjectRow>('select * from objects where id = ?', id);
  return row ? view(row) : null;
}

// ---------------------------------------------------------------------------
// Инвариант 5, одно место на весь проект
// ---------------------------------------------------------------------------

/**
 * Какими будут published_at и actual_at после правки.
 *
 * Перенос триггера app.object_timestamps(). Правила ровно те же:
 *
 * — published_at фиксируется при ПЕРВОМ переходе в published и дальше
 *   неизменен; повторная публикация после снятия сохраняет первую дату;
 * — actual_at поднимается, если изменились цена или фото;
 * — иначе actual_at разрешено двигать только вперёд и не в будущее — это
 *   путь «подтвердить актуальность».
 */
export function stampTimestamps(
  before: Pick<ObjectRow, 'publication_state' | 'published_at' | 'actual_at' | 'price_minor' | 'photos'>,
  after: Partial<Pick<ObjectRow, 'publication_state' | 'actual_at' | 'price_minor' | 'photos'>>,
  at: string = now(),
): { published_at: string | null; actual_at: string } {
  const state = after.publication_state ?? before.publication_state;

  const published_at =
    state === 'published' && before.publication_state !== 'published'
      ? before.published_at ?? at
      : before.published_at;

  const priceChanged = after.price_minor !== undefined
    && after.price_minor !== before.price_minor;
  const photosChanged = after.photos !== undefined
    && after.photos !== before.photos;

  if (priceChanged || photosChanged) {
    return { published_at, actual_at: at };
  }

  const wanted = after.actual_at;
  if (wanted !== undefined && wanted !== before.actual_at) {
    // Назад и в будущее — нельзя: иначе «подтверждение актуальности»
    // становится способом нарисовать свежесть задним числом.
    const ok = wanted > before.actual_at && wanted <= at;
    return { published_at, actual_at: ok ? wanted : before.actual_at };
  }

  return { published_at, actual_at: before.actual_at };
}

// ---------------------------------------------------------------------------
// Создание
// ---------------------------------------------------------------------------

export type NewObject = {
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  price_minor: number;
  zone?: string | null;
  rooms?: number | null;
  area?: number | null;
  floor?: number | null;
  floors_total?: number | null;
  currency?: string | null;
  description?: string | null;
  photos?: string[];
  source?: string | null;
  /** Собственник: либо существующий контакт, либо новый по имени. */
  owner_contact_id?: string | null;
  owner_name?: string | null;
  owner_phone?: string | null;
  /** Мандат. Задан вид — договор создаётся, и объект сразу можно публиковать. */
  mandate_kind?: 'exclusive' | 'non_exclusive' | null;
  mandate_valid_to?: string | null;
  mandate_start_price_minor?: number | null;
  contract_confirmed?: boolean;
  document_url?: string | null;
};

/**
 * Завести объект.
 *
 * Объект всегда рождается ЧЕРНОВИКОМ: публикация — отдельный шаг, и он
 * требует мандата. Иначе инвариант 1 обходится при создании.
 *
 * Всё едет одним батчем: объект, собственник, связь собственности, мандат и
 * записи журнала. Батч D1 — транзакция, поэтому объект без журнальной записи
 * или с половиной связей сохраниться не может.
 */
export async function createObject(input: NewObject): Promise<ObjectView> {
  const agent = await requireAgent();
  const at = now();

  const address = input.address.trim();
  if (!address) throw new Invalid('Адрес обязателен');
  if (!(input.price_minor > 0)) throw new Invalid('Цена должна быть больше нуля');

  const id = newId();
  const photos = toJson(input.photos ?? []);
  const writes = [];

  writes.push(stmt(
    `insert into objects (
       id, kind, deal_type, address, zone, rooms, area, floor, floors_total,
       price_minor, currency, photos, description, source,
       publication_state, published_at, actual_at,
       created_by_agent_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', null, ?, ?, ?, ?)`,
    id, input.kind, input.deal_type, address,
    blank(input.zone), input.rooms ?? null, input.area ?? null,
    input.floor ?? null, input.floors_total ?? null,
    input.price_minor, (input.currency || 'USD').trim().toUpperCase(),
    photos, blank(input.description), blank(input.source),
    at, agent.id, at, at,
  ));
  writes.push(auditStmt('objects', id, 'insert', agent.id, {
    address, price_minor: input.price_minor, deal_type: input.deal_type,
  }));

  // Собственник. Новый контакт достаётся тому, кто его привёл: на этом
  // держится инвариант 4.
  let contactId = input.owner_contact_id ?? null;
  const ownerName = (input.owner_name ?? '').trim();

  if (!contactId && ownerName) {
    contactId = newId();
    const roles = input.deal_type === 'rent' ? ['owner', 'landlord'] : ['owner'];

    writes.push(stmt(
      `insert into contacts (id, kind, name, owner_agent_id, roles, source,
                             created_at, updated_at)
       values (?, 'person', ?, ?, ?, 'заведён с объектом', ?, ?)`,
      contactId, ownerName, agent.id, toJson(roles), at, at,
    ));
    writes.push(auditStmt('contacts', contactId, 'insert', agent.id, { name: ownerName }));

    const phone = (input.owner_phone ?? '').trim();
    if (phone) {
      writes.push(stmt(
        `insert into contact_phones (id, contact_id, phone, phone_normalized,
                                     is_primary, created_at)
         values (?, ?, ?, ?, 1, ?)`,
        newId(), contactId, phone, normalizePhone(phone), at,
      ));
    }
  }

  if (contactId) {
    writes.push(stmt(
      `insert or ignore into object_ownerships (object_id, contact_id, role, share, created_at)
       values (?, ?, 'owner', 1, ?)`,
      id, contactId, at,
    ));
  }

  if (input.mandate_kind) {
    const mandateId = newId();
    writes.push(stmt(
      `insert into mandates (id, object_id, kind, valid_from, valid_to,
                             start_price_minor, listing_agent_id,
                             contract_confirmed, document_url, status,
                             created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      mandateId, id, input.mandate_kind, at.slice(0, 10),
      input.mandate_valid_to ?? null,
      input.mandate_start_price_minor ?? input.price_minor,
      agent.id, flag(input.contract_confirmed ?? false),
      blank(input.document_url), at, at,
    ));
    writes.push(auditStmt('mandates', mandateId, 'insert', agent.id, { object_id: id }));
  }

  await batch(writes);

  const created = await getObject(id);
  if (!created) throw new NotFound('Объект не сохранился');
  return created;
}

// ---------------------------------------------------------------------------
// Правка
// ---------------------------------------------------------------------------

export type ObjectPatch = Partial<Pick<NewObject,
  'kind' | 'deal_type' | 'address' | 'price_minor' | 'zone' | 'rooms' | 'area'
  | 'floor' | 'floors_total' | 'currency' | 'description' | 'photos'>>;

/** Поля, которые агент вправе править. Остальные — только через свои действия. */
const EDITABLE = [
  'kind', 'deal_type', 'address', 'price_minor', 'zone', 'rooms', 'area',
  'floor', 'floors_total', 'currency', 'description', 'photos',
] as const;

export async function updateObject(id: string, patch: ObjectPatch): Promise<ObjectView> {
  const agent = await requireAgent();

  if (!(await canEditObject(id))) {
    throw new Forbidden(
      'Править объект может тот, кто его завёл, listing-агент активного мандата или админ',
    );
  }

  const before = await one<ObjectRow>('select * from objects where id = ?', id);
  if (!before) throw new NotFound('Объект не найден');

  const next: Record<string, string | number | null> = {};
  for (const key of EDITABLE) {
    if (patch[key] === undefined) continue;
    next[key] = key === 'photos'
      ? toJson(patch.photos ?? [])
      : (patch[key] as string | number | null);
  }
  if (typeof next.address === 'string') {
    next.address = next.address.trim();
    if (!next.address) throw new Invalid('Адрес обязателен');
  }
  if (typeof next.price_minor === 'number' && !(next.price_minor > 0)) {
    throw new Invalid('Цена должна быть больше нуля');
  }
  if (Object.keys(next).length === 0) return view(before);

  const at = now();
  const stamps = stampTimestamps(before, next as Partial<ObjectRow>, at);

  const columns = [...Object.keys(next), 'published_at', 'actual_at', 'updated_at'];
  const values = [...Object.values(next), stamps.published_at, stamps.actual_at, at];

  await batch([
    stmt(
      `update objects set ${columns.map((c) => `${c} = ?`).join(', ')} where id = ?`,
      ...values, id,
    ),
    auditStmt('objects', id, 'update', agent.id,
      diffOf(before as unknown as Record<string, unknown>, next)),
  ]);

  const updated = await getObject(id);
  if (!updated) throw new NotFound('Объект не найден');
  return updated;
}

// ---------------------------------------------------------------------------
// Публикация, снятие, актуальность
// ---------------------------------------------------------------------------

/**
 * Опубликовать — инвариант 1.
 *
 * Права те же, что на правку: кто завёл, listing-агент активного мандата,
 * админ. Иначе выходило бы, что править объект посторонний не может, а
 * снять его с каталога — может.
 */
export async function publishObject(id: string): Promise<ObjectView> {
  const agent = await requireAgent();

  if (!(await canEditObject(id))) {
    throw new Forbidden(
      'Публикует объект тот, кто его завёл, listing-агент активного мандата или админ',
    );
  }

  const before = await one<ObjectRow>('select * from objects where id = ?', id);
  if (!before) throw new NotFound('Объект не найден');

  if (!(await activeMandateId(id))) {
    throw new Conflict(
      'Объект нельзя опубликовать без активного мандата. '
      + 'Заключите договор с собственником, затем публикуйте.',
    );
  }

  const at = now();
  const stamps = stampTimestamps(before, { publication_state: 'published' }, at);

  await batch([
    stmt(
      `update objects set publication_state = 'published', published_at = ?,
                          updated_at = ? where id = ?`,
      stamps.published_at, at, id,
    ),
    auditStmt('objects', id, 'update', agent.id, {
      publication_state: { from: before.publication_state, to: 'published' },
    }),
  ]);

  const row = await getObject(id);
  if (!row) throw new NotFound('Объект не найден');
  return row;
}

/** Снять с публикации. Каналы выгрузки помечаются снятыми тем же батчем. */
export async function withdrawObject(id: string): Promise<ObjectView> {
  const agent = await requireAgent();

  if (!(await canEditObject(id))) {
    throw new Forbidden(
      'Снять объект с публикации может тот, кто его завёл, '
      + 'listing-агент активного мандата или админ',
    );
  }

  const before = await one<ObjectRow>('select * from objects where id = ?', id);
  if (!before) throw new NotFound('Объект не найден');

  const at = now();

  await batch([
    stmt(
      `update objects set publication_state = 'withdrawn', updated_at = ? where id = ?`,
      at, id,
    ),
    stmt(
      `update publication_channels set status = 'withdrawn', last_sync_at = ?,
              updated_at = ?
        where object_id = ? and status in ('exported', 'updated')`,
      at, at, id,
    ),
    auditStmt('objects', id, 'update', agent.id, {
      publication_state: { from: before.publication_state, to: 'withdrawn' },
    }),
  ]);

  const row = await getObject(id);
  if (!row) throw new NotFound('Объект не найден');
  return row;
}

/**
 * Подтвердить актуальность — третий случай инварианта 5.
 *
 * Актуальность это утверждение о чужом объекте, поэтому подтверждать её
 * может только тот, кто за объект отвечает.
 */
export async function confirmActual(id: string): Promise<string> {
  const agent = await requireAgent();

  if (!(await canEditObject(id))) {
    throw new Forbidden(
      'Подтвердить актуальность может тот, кто завёл объект, '
      + 'listing-агент активного мандата или админ',
    );
  }

  const exists = await one<{ id: string }>('select id from objects where id = ?', id);
  if (!exists) throw new NotFound('Объект не найден');

  const at = now();
  await batch([
    stmt('update objects set actual_at = ?, updated_at = ? where id = ?', at, at, id),
    auditStmt('objects', id, 'update', agent.id, { actual_at: { from: null, to: at } }),
  ]);

  return at;
}

/** Пустая строка — это отсутствие значения, а не значение. */
function blank(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

export { all };
