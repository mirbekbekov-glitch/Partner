import 'server-only';
import { all, batch, flag, newId, now, one, run, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { normalizeName, normalizePhone } from './normalize';
import { coarseOf, isSpaceType } from '../space-types';
import { BudgetTooLow, Conflict, Forbidden, Invalid, NotFound } from './errors';
import { priceFloor } from './catalog';
import { fromMinor } from './money';

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
  /**
   * Что человек ПРЕДЛАГАЕТ. Пусто — обычная заявка на поиск.
   *
   * Сторона заявки выводится отсюда, а не из отдельного флага: два поля
   * об одном пришлось бы держать в согласии руками.
   */
  offer_deal: 'sale' | 'rent' | null;
  /** Адрес предлагаемого объекта. У заявки на поиск его не бывает. */
  address: string | null;
  housing_type: string | null;
  /** Подробный вид: офис, кабинет, рабочее место. */
  space_type: string | null;
  rooms: number | null;
  /** Срок аренды в днях. */
  term_days_min: number | null;
  term_days_max: number | null;
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
  /** Подробный тип: офис, кабинет, рабочее место. Огрубление выводится. */
  space_type?: string | null;
  rooms?: number | null;
  /** Срок аренды в днях. У покупки не бывает. */
  term_days_min?: number | null;
  term_days_max?: number | null;
  district?: string | null;
  budget_minor?: number | null;
  budget_currency?: string | null;
  wishes?: string | null;
  /** Сторона: что человек предлагает. Пусто — он ищет. */
  offer_deal?: string | null;
  address?: string | null;
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
  // Сторона заявки. Как и направление, чужое значение не роняет заявку:
  // она просто окажется заявкой на поиск, и агент разберётся по телефону.
  const offer = input.offer_deal === 'sale' || input.offer_deal === 'rent'
    ? input.offer_deal : null;

  // У собственника направления поиска нет: «ищу» и «предлагаю» — это одна
  // и та же строка ленты, и заявка, помеченная сразу обоими, читалась бы
  // по-разному в разных местах кабинета.
  const deal = offer ? null
    : input.deal === 'buy' || input.deal === 'rent' ? input.deal : null;

  // Адрес принимаем только у собственника: у ищущего адреса нет, и поле,
  // пришедшее с чужой стороны, в заявку попасть не должно.
  const address = offer ? ((input.address ?? '').trim().slice(0, 200) || null) : null;
  const kind = input.housing_type && KINDS.includes(input.housing_type)
    ? input.housing_type : null;

  const rooms = input.rooms && input.rooms >= 1 && input.rooms <= 20 ? input.rooms : null;

  // Что именно ищут. Словарь подробнее, чем housing_type, и огрублённое
  // значение выводится ИЗ НЕГО, а не приходит отдельно: иначе два поля
  // разойдутся, и заявка на кабинет окажется заявкой на квартиру.
  const space = isSpaceType(input.space_type ?? null) ? input.space_type! : null;
  const coarse = space ? coarseOf(space) : kind;

  // Срок аренды в днях. У покупки срока нет — и если он пришёл, это
  // мусор из формы, а не намерение человека.
  const isRent = deal === 'rent';
  const day = (v: number | null | undefined) =>
    isRent && v && v > 0 && v <= 3650 ? Math.trunc(v) : null;
  let termMin = day(input.term_days_min);
  let termMax = day(input.term_days_max);
  // Перепутанные местами границы — обычная опечатка, а не повод терять
  // заявку: меняем местами молча.
  if (termMin && termMax && termMin > termMax) [termMin, termMax] = [termMax, termMin];

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

  // Порог рынка. Бюджет ниже него — заявка НЕ принимается: по такой цене
  // в этом срезе нет ни одного объявления, и приняв её, мы обещаем
  // человеку поиск того, чего нет. Разговор про деньги всё равно
  // состоится — лучше сейчас, чем через день ожидания и на раздражении.
  //
  // Проверка стоит ЗДЕСЬ, а не в форме: форма — удобство, и проверка,
  // живущая только в ней, не значит ничего.
  //
  // Порога может не быть вовсе — тогда ничего не запрещаем. Так бывает,
  // когда сопоставимых объявлений мало: рынок в этом срезе нам неизвестен,
  // и запрет по незнанию хуже отсутствия запрета.
  if (budget && deal) {
    const floor = await priceFloor({
      deal: deal === 'buy' ? 'sale' : 'rent',
      kind,
      zone: districtId || districtOther ? district : null,
    });

    if (floor && floor.currency === currency && budget < floor.floor_minor) {
      // fromMinor отдаёт null только для null на входе; здесь он не
      // может быть пустым — floor_minor проверен в priceFloor.
      throw new BudgetTooLow(
        fromMinor(floor.floor_minor) ?? 0,
        floor.currency,
        floor.based_on,
      );
    }
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
      `insert into requests (id, deal, offer_deal, address, housing_type, rooms,
                             space_type, term_days_min, term_days_max,
                             district_id, district_other, budget_minor,
                             budget_currency, wishes,
                             name, phone, phone_normalized, public_consent,
                             status, source, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      id, deal, offer, address, coarse, rooms,
      space, termMin, termMax,
      districtId, districtOther, budget,
      currency === 'KGS' ? 'KGS' : 'USD', wishes, name, phone, normalized,
      flag(input.consent ?? false), (input.source ?? '').trim() || null, at, at,
    ),
    auditStmt('requests', id, 'insert', null,
      { deal, offer_deal: offer, housing_type: kind }),
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
export type RequestFeedItem = Omit<RequestRow, 'phone'> & {
  phone: string | null;
  district: string | null;
  district_name: string | null;
  agent_name: string | null;
  mine_state: 'available' | 'mine' | 'other';
  budget: number | null;
  overdue: boolean;
  response_minutes: number;
  public_consent_flag: boolean;
};

/**
 * Лента заявок.
 *
 * Телефон закрыт, пока человек не дал согласия и пока заявку не взяли в
 * работу. Это правило из задания: контакт принадлежит человеку, а не
 * первому агенту, который открыл ленту.
 *
 * mine_state отвечает на вопрос страницы одним словом: заявка свободна,
 * моя или чужая. Считать это на странице значило бы повторять правило в
 * каждом месте, где показывается кнопка «Взять».
 */
/**
 * Сколько открытых заявок просрочено и сколько свободно.
 *
 * Считается в базе, а не по загруженной странице: страница показывает
 * двадцать строк, а норматив нарушают все, и число должно быть честным.
 */
export async function requestCounts(): Promise<
  { overdue: number; free: number; offers: number }
> {
  await requireAgent();
  const deadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const row = await one<{ overdue: number; free: number; offers: number }>(
    `select
       sum(case when r.first_response_at is null and r.created_at < ?1
                then 1 else 0 end) as overdue,
       sum(case when r.agent_id is null then 1 else 0 end) as free,
       sum(case when r.offer_deal is not null then 1 else 0 end) as offers
     from requests r
     where r.status in ('new', 'in_work')`,
    deadline,
  );

  return { overdue: row?.overdue ?? 0, free: row?.free ?? 0, offers: row?.offers ?? 0 };
}

export type RequestTab = 'open' | 'offers' | 'mine' | 'all' | 'closed';

export async function requestFeed(
  tab: RequestTab = 'open',
  page?: number | null,
): Promise<{ rows: RequestFeedItem[]; total: number }> {
  const agent = await requireAgent();
  const admin = await isAdmin();

  // Отбор стороны живёт в запросе, а не в странице: иначе вкладка
  // фильтровала бы одну загруженную страницу, а число над ней считалось
  // бы по всей базе — и они разошлись бы на первой же сотне заявок.
  const where =
    tab === 'open' ? `r.status = 'new'`
    : tab === 'offers' ? `r.offer_deal is not null and r.status in ('new', 'in_work')`
    : tab === 'mine' ? 'r.agent_id = ?1'
    : tab === 'all' ? `r.status in ('new', 'in_work')`
    : `r.status in ('closed', 'expired')`;

  // Норматив первого ответа — час. Заявка, пролежавшая дольше, обычно уже
  // не нужна, и это должно быть видно сразу.
  const deadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const size = 20;
  const p = Math.min(Math.max(Math.trunc(page ?? 1) || 1, 1), 100_000);

  const rows = await all<RequestRow & {
    district_name: string | null; agent_name: string | null; total_count: number;
  }>(
    `select r.*, d.name as district_name, ag.full_name as agent_name,
            count(*) over () as total_count
       from requests r
       left join districts d on d.id = r.district_id
       left join agents ag on ag.id = r.agent_id
      where ${where}
      order by r.created_at desc limit ${size} offset ${(p - 1) * size}`,
    // Параметр уходит только там, где он есть в запросе: «мои» — это
    // единственная вкладка с ?1, и лишняя привязка роняет запрос целиком.
    ...(tab === 'mine' ? [agent.id] : []),
  );

  const items = rows.map((row) => ({
    ...row,
    phone: admin || row.agent_id === agent.id || row.public_consent === 1
      ? row.phone
      : null,
    district: row.district_name,
    mine_state: row.agent_id === null
      ? 'available' as const
      : row.agent_id === agent.id ? 'mine' as const : 'other' as const,
    budget: row.budget_minor === null ? null : row.budget_minor / 100,
    overdue: row.first_response_at === null
      && row.status !== 'closed' && row.status !== 'expired'
      && row.created_at < deadline,
    response_minutes: Math.max(0, Math.round(
      ((row.first_response_at ? Date.parse(row.first_response_at) : Date.now())
        - Date.parse(row.created_at)) / 60000,
    )),
    public_consent_flag: row.public_consent === 1,
  }));

  return { rows: items, total: rows[0]?.total_count ?? 0 };
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

/**
 * Превратить заявку в клиента и потребность.
 *
 * Это момент, когда безымянный номер из ленты становится записью CRM: у
 * него появляется карточка контакта и потребность, по которой дальше
 * строятся подборы. Телефон при этом НЕ переносится: он уже есть в заявке,
 * а дубль в контактах создал бы вторую запись того же человека и сломал
 * правило «один человек — одна запись».
 *
 * Повтор безвреден: заявка помнит, во что превратилась, и второй вызов
 * возвращает прежний контакт, а не заводит второй.
 */
export async function convertRequest(requestId: string): Promise<string> {
  const agent = await requireAgent();
  const admin = await isAdmin();

  const row = await one<RequestRow>('select * from requests where id = ?', requestId);
  if (!row) throw new NotFound('Заявка не найдена');

  if (row.status !== 'in_work' || (row.agent_id !== agent.id && !admin)) {
    throw new Forbidden('Превратить в клиента можно только свою заявку в работе');
  }
  if (row.contact_id) return row.contact_id;

  const contactId = newId();
  const requirementId = newId();
  const at = now();

  const districtName = row.district_id
    ? (await one<{ name: string }>('select name from districts where id = ?',
        row.district_id))?.name ?? null
    : row.district_other;

  const name = row.name
    ?? `Заявка ${new Date(row.created_at).toLocaleString('ru-RU', {
      timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })}`;

  await batch([
    stmt(
      `insert into contacts (id, kind, name, owner_agent_id, roles, source,
                             created_at, updated_at)
       values (?, 'person', ?, ?, ?, 'из заявки с сайта', ?, ?)`,
      contactId, name, row.agent_id ?? agent.id,
      JSON.stringify(row.deal === 'rent' ? ['tenant'] : ['buyer']), at, at,
    ),
    stmt(
      `insert into requirements (id, contact_id, deal_type, budget_max_minor,
                                 zones, rooms, requirements_text, agent_id,
                                 status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
      requirementId, contactId, row.deal === 'rent' ? 'rent' : 'sale',
      row.budget_minor,
      JSON.stringify(districtName ? [districtName] : []),
      JSON.stringify(row.rooms ? [row.rooms] : []),
      row.wishes, row.agent_id ?? agent.id, at, at,
    ),
    stmt(
      `update requests set contact_id = ?, requirement_id = ?, updated_at = ?
        where id = ?`,
      contactId, requirementId, at, requestId,
    ),
    auditStmt('requests', requestId, 'update', agent.id,
      { contact_id: contactId, requirement_id: requirementId }),
  ]);

  return contactId;
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

/**
 * Заявки, по которым пора напомнить агенту.
 *
 * Зачем это вообще. Заявку взяли, сутки прошли, подходящего в каталоге
 * нет — и дальше происходит худшее: ничего. Клиент ждёт, агент занят
 * другим, заявка тихо стареет до «передумал». Разговор про бюджет
 * состоится всё равно, но через неделю и уже с раздражением.
 *
 * Пишем АГЕНТУ, а не клиенту. Во-первых, канала к клиенту нет: у нас его
 * телефон, а написать на телефон в Telegram нельзя, и WhatsApp для
 * исходящих требует Business API. Во-вторых — и это важнее — «поднимите
 * бюджет» от бота читается как «заплатите больше», а от человека, который
 * уже говорил с клиентом, как совет. Нажимать на деньги должен тот, кто
 * отвечает за результат.
 *
 * Что считается «нет вариантов»: ноль опубликованных объектов, подходящих
 * под направление, вид жилья и бюджет заявки. Не «мало» и не «так себе» —
 * ровно ноль, потому что это единственное, что можно утверждать.
 *
 * Условие по ответу агента НЕ ставится намеренно. Владелец площадки
 * сказал прямо: напоминать надо, даже если агент связался, — звонок
 * «здравствуйте, я взял вашу заявку» не приближает к результату, если
 * показывать нечего.
 */
export type RequestNudge = {
  request_id: string;
  agent_id: string;
  telegram_id: number;
  body: string;
};

export async function idleRequests(idleMs = DAY_MS): Promise<RequestNudge[]> {
  const since = new Date(Date.now() - idleMs).toISOString();

  const rows = await all<{
    id: string; name: string | null; phone: string;
    deal: string | null; housing_type: string | null;
    budget_minor: number | null; budget_currency: string;
    district: string | null; agent_id: string; telegram_id: number;
    taken_at: string;
  }>(
    `select r.id, r.name, r.phone, r.deal, r.housing_type,
            r.budget_minor, r.budget_currency,
            coalesce(d.name, r.district_other) as district,
            r.agent_id, ag.telegram_id, r.taken_at
       from requests r
       join agents ag on ag.id = r.agent_id
       left join districts d on d.id = r.district_id
      where r.status = 'in_work'
        and r.taken_at is not null
        and r.taken_at < ?
        and r.idle_notified_at is null
        -- Заблокированному и неодобренному напоминать не о чем, и
        -- непривязанному Telegram доставить нечем.
        and ag.status = 'approved'
        and ag.telegram_id is not null`,
    since,
  );

  const nudges: RequestNudge[] = [];

  for (const row of rows) {
    // Сколько в каталоге подходящего ПРЯМО СЕЙЧАС. Считаем на каждую
    // заявку отдельным запросом: заявок за сутки единицы, а один общий
    // запрос с соединением по диапазонам читался бы вдвое хуже.
    const fits = await one<{ n: number }>(
      `select count(*) as n from objects o
        where o.publication_state = 'published'
          and (?1 is null or o.deal_type = ?1)
          and (?2 is null or o.kind = ?2)
          and (?3 is null or o.zone = ?3)
          and (?4 is null or (o.currency = ?5 and o.price_minor <= ?4))`,
      row.deal === 'rent' ? 'rent' : row.deal === 'buy' ? 'sale' : null,
      row.housing_type, row.district,
      row.budget_minor, row.budget_currency,
    );

    // Есть что показать — напоминать не о чем: агент сам разберётся.
    if ((fits?.n ?? 0) > 0) continue;

    const floor = row.deal
      ? await priceFloor({
          deal: row.deal === 'rent' ? 'rent' : 'sale',
          kind: row.housing_type,
          zone: row.district,
        })
      : null;

    const who = row.name ? `${row.name}, ${row.phone}` : row.phone;
    const budget = row.budget_minor
      ? `${fromMinor(row.budget_minor)} ${row.budget_currency}`
      : 'не указан';

    nudges.push({
      request_id: row.id,
      agent_id: row.agent_id,
      telegram_id: row.telegram_id,
      body: [
        `Заявке сутки, подходящего в каталоге нет.`,
        `Клиент: ${who}`,
        `Бюджет: ${budget}`,
        row.district ? `Район: ${row.district}` : null,
        floor && row.budget_minor && floor.currency === row.budget_currency
          && row.budget_minor < floor.floor_minor
          ? `Дешевле ${fromMinor(floor.floor_minor)} ${floor.currency} в этом`
            + ` срезе нет ни одного объявления (по ${floor.based_on}).`
            + ` Предложите поднять бюджет — иначе он упустит подходящее.`
          : `Позвоните и уточните, что клиент готов двигать: цену, район или сроки.`,
      ].filter(Boolean).join('\n'),
    });
  }

  return nudges;
}

/**
 * Отметить, что по заявке напомнили.
 *
 * Вызывается ПОСЛЕ доставки, а не до: иначе неудачная отправка пометила бы
 * заявку как отработанную, и агент не узнал бы о ней никогда.
 */
export async function markRequestNudged(requestId: string): Promise<void> {
  await run('update requests set idle_notified_at = ? where id = ?', now(), requestId);
}

/**
 * Заявки, которые никто не взял.
 *
 * Самое дорогое из всего, о чём может напомнить бот: клиент написал,
 * прошло два часа, заявка лежит в ленте «новой», и об этом не знает
 * никто. Через сутки он уже написал в другое агентство.
 *
 * ОДНО сообщение на всех, а не по сообщению на заявку. Пять заявок за
 * ночь — это пять уведомлений в восемь утра, после которых бота глушат, и
 * вместе со спамом теряется то единственное, ради чего он был нужен.
 *
 * ТИХИЕ ЧАСЫ. Заявка может прийти в три ночи, и напоминание в три ночи
 * разбудит агента ради того, с чем он всё равно ничего не сделает до
 * утра. Поэтому с 21:00 до 8:00 по Бишкеку бот молчит, а накопленное
 * отдаёт утром одним сообщением. Отметка при этом НЕ ставится — иначе
 * ночные заявки оказались бы отмеченными как отработанные и утром никто
 * бы о них не узнал.
 */
export type UnclaimedDigest = {
  /** Кому отправлять: все одобренные агенты с привязанным Telegram. */
  recipients: Array<{ agent_id: string; telegram_id: number }>;
  /** Что отметить после доставки. */
  request_ids: string[];
  body: string;
};

/** Час в Бишкеке (UTC+6) без зависимости от часового пояса машины. */
function bishkekHour(at: Date): number {
  return new Date(at.getTime() + 6 * 60 * 60 * 1000).getUTCHours();
}

const QUIET_FROM = 21;
const QUIET_TO = 8;

export async function unclaimedRequests(
  idleMs = 2 * 60 * 60 * 1000,
  at: Date = new Date(),
): Promise<UnclaimedDigest | null> {
  const hour = bishkekHour(at);
  if (hour >= QUIET_FROM || hour < QUIET_TO) return null;

  const since = new Date(at.getTime() - idleMs).toISOString();

  const rows = await all<{
    id: string; created_at: string; deal: string | null;
    housing_type: string | null; district: string | null;
    budget_minor: number | null; budget_currency: string;
  }>(
    `select r.id, r.created_at, r.deal, r.housing_type,
            coalesce(d.name, r.district_other) as district,
            r.budget_minor, r.budget_currency
       from requests r
       left join districts d on d.id = r.district_id
      where r.status = 'new'
        -- Сегодня это условие избыточно: взятие ставит статус in_work, и
        -- проверено мутацией — снятие строки прогон не валит. Оставлено
        -- намеренно: статус и агент меняются разными путями, и однажды
        -- появится путь, который поставит 'new', не сняв агента. Тогда
        -- заявка ушла бы в сводку как ничья, имея владельца.
        and r.agent_id is null
        and r.created_at < ?
        and r.unclaimed_notified_at is null
      order by r.created_at
      limit 20`,
    since,
  );
  if (rows.length === 0) return null;

  const recipients = await all<{ agent_id: string; telegram_id: number }>(
    `select id as agent_id, telegram_id from agents
      where status = 'approved' and telegram_id is not null`,
  );
  if (recipients.length === 0) return null;

  const DEAL: Record<string, string> = { buy: 'покупка', rent: 'аренда' };

  const lines = rows.map((r) => {
    const hours = Math.floor((at.getTime() - Date.parse(r.created_at)) / 3_600_000);
    const what = [
      r.deal ? DEAL[r.deal] : null,
      r.housing_type,
      r.district,
      r.budget_minor ? `до ${fromMinor(r.budget_minor)} ${r.budget_currency}` : null,
    ].filter(Boolean).join(', ');
    return `• ${what || 'без подробностей'} — ждёт ${hours} ч`;
  });

  return {
    recipients,
    request_ids: rows.map((r) => r.id),
    body: [
      rows.length === 1
        ? 'Заявку никто не взял:'
        : `Заявок без агента: ${rows.length}`,
      ...lines,
      '',
      'Откройте «Заявки» в кабинете и возьмите в работу.',
    ].join('\n'),
  };
}

/** Отметить, что про непринятые заявки написали. После доставки. */
export async function markUnclaimedNudged(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await run(
    `update requests set unclaimed_notified_at = ?
      where id in (${ids.map(() => '?').join(', ')})`,
    now(), ...ids,
  );
}
