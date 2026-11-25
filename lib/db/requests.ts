import 'server-only';
import { all, batch, flag, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { normalizeName, normalizePhone } from './normalize';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Заявки-запросы: «подберите мне» с публичной страницы.
 *
 * Отличие от заявки по объекту (leads.ts): там человек спрашивает про
 * конкретный объект, здесь — говорит, что ищет, и объекта ещё нет.
 *
 * ТЕЛЕФОН — ЕДИНСТВЕННОЕ ОБЯЗАТЕЛЬНОЕ ПОЛЕ. Чем меньше обязательных полей,
 * тем больше заявок доходит; всё остальное агент спросит сам, когда
 * позвонит.
 *
 * Согласие показать контакт агентам даёт ЧЕЛОВЕК, а не агент: без него
 * телефон не видит никто, кроме админа и того, кто взял заявку в работу.
 */

export type RequestRow = {
  id: string;
  deal: 'buy' | 'rent' | null;
  housing_type: string | null;
  rooms: number | null;
  district_id: string | null;
  district_other: string | null;
  budget_minor: number | null;
  budget_currency: string;
  wishes: string | null;
  name: string | null;
  phone: string;
  phone_normalized: string;
  public_consent: number;
  status: 'new' | 'in_work' | 'closed' | 'expired';
  agent_id: string | null;
  taken_at: string | null;
  first_response_at: string | null;
  closed_reason: string | null;
  closed_at: string | null;
  source: string | null;
  contact_id: string | null;
  requirement_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Сколько заявок с одного номера в сутки. */
const PER_PHONE_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS = ['flat', 'room', 'house', 'townhouse', 'land', 'commercial', 'garage'];

export type NewRequest = {
  phone: string;
  name?: string | null;
  deal?: string | null;
  housing_type?: string | null;
  rooms?: number | null;
  district?: string | null;
  budget_minor?: number | null;
  budget_currency?: string | null;
  wishes?: string | null;
  consent?: boolean;
  source?: string | null;
  /** Поле-приманка. Заполнено — отвечаем как при успехе, но не пишем. */
  trap?: string | null;
};

export async function submitRequest(input: NewRequest): Promise<string> {
  if ((input.trap ?? '').trim() !== '') return newId();

  const phone = input.phone.trim();
  const normalized = normalizePhone(phone);
  if (normalized.length < 9) throw new Invalid('Проверьте номер телефона');

  const name = (input.name ?? '').trim() || null;
  if (name && name.length > 120) throw new Invalid('Имя слишком длинное');

  const wishes = (input.wishes ?? '').trim() || null;
  if (wishes && wishes.length > 2000) throw new Invalid('Сообщение слишком длинное');

  // Направление и тип приводятся к известным значениям. Чужое значение НЕ
  // роняет заявку, а просто остаётся незаполненным: потерять заявку из-за
  // кривого параметра хуже, чем принять её без направления.
  const deal = input.deal === 'buy' || input.deal === 'rent' ? input.deal : null;
  const kind = input.housing_type && KINDS.includes(input.housing_type)
    ? input.housing_type : null;

  const rooms = input.rooms && input.rooms >= 1 && input.rooms <= 20 ? input.rooms : null;

  const currency = (input.budget_currency ?? 'USD').toUpperCase();
  const budget = input.budget_minor && input.budget_minor > 0 ? input.budget_minor : null;

  // Район: сначала ищем в справочнике, иначе кладём как свой вариант —
  // чтобы не портить список и не терять написанное человеком.
  let districtId: string | null = null;
  let districtOther: string | null = null;
  const district = (input.district ?? '').trim();

  if (district) {
    const found = await one<{ id: string }>(
      `select id from districts where active = 1 and name_normalized = ? limit 1`,
      normalizeName(district),
    );
    if (found) districtId = found.id;
    else districtOther = district.slice(0, 120);
  }

  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();

  // Склейка повторов: человек отправил форму трижды — заявка одна. На
  // прежнем сайте этого не было, и в ленте лежали тройники.
  const repeat = await one<{ id: string }>(
    `select id from requests
      where phone_normalized = ? and created_at > ?
        and status in ('new', 'in_work')
      order by created_at desc limit 1`,
    normalized, dayAgo,
  );
  if (repeat) return repeat.id;

  const recent = await one<{ n: number }>(
    'select count(*) as n from requests where phone_normalized = ? and created_at > ?',
    normalized, dayAgo,
  );
  if ((recent?.n ?? 0) >= PER_PHONE_PER_DAY) {
    throw new Invalid('Слишком много заявок с этого номера');
  }

  const id = newId();
  const at = now();

  await batch([
    stmt(
      `insert into requests (id, deal, housing_type, rooms, district_id,
                             district_other, budget_minor, budget_currency, wishes,
                             name, phone, phone_normalized, public_consent,
                             status, source, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      id, deal, kind, rooms, districtId, districtOther, budget,
      currency === 'KGS' ? 'KGS' : 'USD', wishes, name, phone, normalized,
      flag(input.consent ?? false), (input.source ?? '').trim() || null, at, at,
    ),
    auditStmt('requests', id, 'insert', null, { deal, housing_type: kind }),
  ]);

  return id;
}

// ---------------------------------------------------------------------------
// Лента заявок в кабинете
// ---------------------------------------------------------------------------

/**
 * Что из заявки видит агент.
 *
 * Телефон закрыт, пока человек не дал согласия и пока заявку не взяли в
 * работу. Это правило из задания: контакт принадлежит человеку, а не
 * первому агенту, который открыл ленту.
 */
export type RequestFeedItem = Omit<RequestRow, 'phone' | 'phone_normalized'> & {
  phone: string | null;
  district_name: string | null;
};

export async function requestFeed(
  status?: RequestRow['status'],
): Promise<RequestFeedItem[]> {
  const agent = await requireAgent();
  const admin = await isAdmin();

  const params: (string | number)[] = [agent.id];
  let filter = '';
  if (status) { filter = 'and r.status = ?'; params.push(status); }

  const rows = await all<RequestRow & { district_name: string | null }>(
    `select r.*, d.name as district_name
       from requests r left join districts d on d.id = r.district_id
      where 1 = 1 ${filter}
      order by r.created_at desc limit 200`,
    ...params.slice(1),
  );

  return rows.map((row) => ({
    ...row,
    phone: admin || row.agent_id === agent.id || row.public_consent === 1
      ? row.phone
      : null,
  }));
}

/**
 * Взять заявку в работу.
 *
 * Берётся ОДНИМ запросом с условием «ещё не взята»: проверить, а потом
 * записать двумя действиями нельзя — два агента, нажавшие одновременно,
 * оба увидели бы «свободна» и оба записали бы себя.
 */
export async function takeRequest(requestId: string): Promise<RequestRow> {
  const agent = await requireAgent();
  const at = now();

  const changed = await (await import('./sql')).run(
    `update requests set status = 'in_work', agent_id = ?, taken_at = ?, updated_at = ?
      where id = ? and status = 'new' and agent_id is null`,
    agent.id, at, at, requestId,
  );

  if (changed === 0) {
    const existing = await one<RequestRow>('select * from requests where id = ?', requestId);
    if (!existing) throw new NotFound('Заявка не найдена');
    throw new Conflict('Заявку уже взял другой агент');
  }

  await batch([auditStmt('requests', requestId, 'update', agent.id,
    { status: { from: 'new', to: 'in_work' } })]);

  const row = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!row) throw new NotFound('Заявка не найдена');
  return row;
}

/** Вернуть заявку в ленту: не дозвонился, не мой профиль. */
export async function releaseRequest(requestId: string): Promise<RequestRow> {
  const agent = await requireAgent();

  const before = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!before) throw new NotFound('Заявка не найдена');

  if (before.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Вернуть в ленту может тот, кто взял заявку, или админ');
  }

  const at = now();
  await batch([
    stmt(
      `update requests set status = 'new', agent_id = null, taken_at = null,
                           updated_at = ? where id = ?`,
      at, requestId,
    ),
    auditStmt('requests', requestId, 'update', agent.id,
      { status: { from: before.status, to: 'new' } }),
  ]);

  const row = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!row) throw new NotFound('Заявка не найдена');
  return row;
}

/** Отметить, что агент отчитался о работе: срок первого ответа. */
export async function answerRequest(requestId: string): Promise<RequestRow> {
  const agent = await requireAgent();

  const before = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!before) throw new NotFound('Заявка не найдена');
  if (before.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Отчитаться может тот, кто взял заявку');
  }

  const at = now();
  await batch([
    // Отметка ставится один раз: срок первого ответа на то и первый.
    stmt(
      `update requests set first_response_at = coalesce(first_response_at, ?),
                           updated_at = ? where id = ?`,
      at, at, requestId,
    ),
    auditStmt('requests', requestId, 'update', agent.id, { first_response_at: at }),
  ]);

  const row = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!row) throw new NotFound('Заявка не найдена');
  return row;
}

export type CloseReason = 'deal' | 'found_self' | 'changed_mind' | 'no_answer'
                        | 'spam' | 'other';

/** Закрыть заявку. Причина обязательна: без неё лента не анализируется. */
export async function closeRequest(
  requestId: string,
  reason: CloseReason,
): Promise<RequestRow> {
  const agent = await requireAgent();

  const before = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!before) throw new NotFound('Заявка не найдена');
  if (before.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Закрыть заявку может тот, кто её ведёт, или админ');
  }
  if (before.status !== 'in_work') {
    throw new Conflict('Закрывать можно только заявку в работе');
  }

  const at = now();
  await batch([
    stmt(
      `update requests set status = 'closed', closed_reason = ?, closed_at = ?,
                           updated_at = ? where id = ?`,
      reason, at, at, requestId,
    ),
    auditStmt('requests', requestId, 'update', agent.id,
      { status: { from: before.status, to: 'closed' }, closed_reason: reason }),
  ]);

  const row = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!row) throw new NotFound('Заявка не найдена');
  return row;
}
