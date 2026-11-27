/**
 * Прогон инвариантов на настоящей D1.
 *
 * База здесь не поддельная: Miniflare поднимает тот же движок, что работает
 * в продакшене, со всеми особенностями SQLite. Заглушены только две вещи,
 * которых вне Next не существует: cookies() и модуль привязок.
 *
 * Смысл этих тестов не в том, чтобы они были зелёными, а в том, чтобы они
 * краснели, когда инвариант сломан. Тот же принцип, что и в прежнем наборе
 * на Postgres.
 */
import { setEnv } from './stubs/cloudflare-workers';
import { resetCookies, setCookie } from './stubs/next-headers';

import { SESSION_COOKIE, currentAgent, endSession, sessionAgent } from '@/lib/db/session';
import { completeLogin, requestLogin, revokePendingLinks } from '@/lib/db/login';
import { inviteAgent } from '@/lib/db/invites';
import { approvedColleagues } from '@/lib/db/agents';
import { looksLikeSameName, nameKey } from '@/lib/contact-match';
import { outbox, tokenFromLastLetter } from './stubs/email';
import {
  confirmActual, createObject, getObject, publishObject,
  updateObject, withdrawObject,
} from '@/lib/db/objects';
import {
  createMandate, expireMandates, setMandateTerms, terminateMandate,
} from '@/lib/db/mandates';
import { canSeeContact } from '@/lib/db/access';
import { createRequirement, updateRequirement } from '@/lib/db/requirements';
import { createActivity, reassignActivity, setActivityDone } from '@/lib/db/activities';
import { listLeads, setLeadStatus, submitLead } from '@/lib/db/leads';
import {
  idleRequests, markRequestNudged, markUnclaimedNudged, requestCounts, requestFeed,
  submitRequest, takeRequest, unclaimedRequests,
} from '@/lib/db/requests';
import {
  catalogAgent, catalogAgentById, catalogAgents, catalogCities, catalogCount,
  catalogCurrencies, catalogObject, catalogPage, catalogRate, priceFloor,
  catalogZoneCounts, catalogZones,
} from '@/lib/db/catalog';
import {
  deleteAvatar, deletePhoto, listPhotos, photoKey, photoUrl,
  photosMissingThumb, putAvatar, putPhoto, putThumb, readPhoto, sniff,
} from '@/lib/db/photos';
import { fullKeyOf, isOwnPhoto, thumbKey, thumbOf } from '@/lib/photo-url';
import { feedXml, inFeed } from '@/lib/feed';
import { mhouseOffers, mhouseXml } from '@/lib/mhouse-feed';
import { toCsv } from '@/lib/csv';
import { convert, parseNbkr } from '@/lib/fx';
import { contactLinks, phoneDigits } from '@/lib/contact-links';
import { coarseOf, SPACE_TYPES } from '@/lib/space-types';
import { COMMERCIAL_TYPE, commercialCode } from '@/lib/mhouse';
import { refreshRates, usdRate } from '@/lib/db/fx';
import { GET as exportContacts } from '@/app/cabinet/contacts/export/route';
import {
  catalogHref, hasAnyFilter, parseCatalogFilters,
} from '@/lib/catalog-params';
import { listingSchema } from '@/lib/listing-schema';
import { LANGS, placeName, spaceName, t } from '@/lib/i18n';
import { citiesOf, regionOf, regions, zoneMatch, zonesOf } from '@/lib/geo';
import {
  completeTelegramLink, startTelegramLink, sweepTelegramLinks, unlinkTelegram,
} from '@/lib/db/telegram';
import { POST as telegramWebhook } from '@/app/api/telegram/webhook/route';
import {
  activeMandateOf, cabinetCounters, contactDuplicates, contactList, contactObjects,
  dealList, duplicatesOf, myActivities, objectCard, objectList, requirementList,
} from '@/lib/db/cabinet';
import {
  approveAgent, blockAgent, clearMyOrganization, confirmAgentOrganization,
  confirmAgentCertificate, ensureAgentByEmail, getAgent, setAgentRole,
  setMyOrganization, updateProfile,
} from '@/lib/db/agents';
import {
  claimNotifications, enqueueDueReminders, markNotification,
} from '@/lib/db/notifications';
import { createMatch, setMatchStatus } from '@/lib/db/matches';
import {
  closeDeal, createDealFromMatch, failDeal, getDeal,
  indicativeCommission, setDealStatus,
} from '@/lib/db/deals';
import {
  addPhone, contactPhones, createContact, findContactByPhone,
  mergeContacts, removeObjectOwnership, setObjectOwnership, transferContact,
  updateContact,
} from '@/lib/db/contacts';
import { commissionShares, commissionTotal } from '@/lib/db/commission';
import { normalizePhone } from '@/lib/db/normalize';
import { draftsFromCatalog, parseCsv } from '@/lib/catalog-csv';
import { importCatalog, IMPORT_SOURCE } from '@/lib/db/catalog-import';
import { BudgetTooLow, Conflict, Forbidden, Invalid, NotFound } from '@/lib/db/errors';
import houseKgPage from '../fixtures/house-kg-search.html?raw';
import houseKgRent from '../fixtures/house-kg-rent.html?raw';
import {
  bumpedAt, parseListingPage, parsePrices, parseSearchPage, searchUrl, sellerOf,
  specsOf,
} from '@/lib/market/house-kg';
import {
  estimate, markGone, marketLookalikes, marketSize, observedRate, ownerLeads,
  ownersWithoutDate, saveCards, setListingPage,
} from '@/lib/db/market';
import { addressOverlap, resemble, resembleAll } from '@/lib/market/duplicate';
import { exportState, lastPull, markExported, recordPull } from '@/lib/db/feed-log';
import { invitation, rank, type OwnerRow } from '@/lib/market/owners';
import {
  awayFromMarket, median, quantile, rateFromPairs, valuate, type Comparable,
} from '@/lib/market/valuation';

type Result = { name: string; ok: boolean; note?: string };
const results: Result[] = [];

function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
}

async function throws(name: string, fn: () => Promise<unknown>, kind: Function) {
  try {
    await fn();
    check(name, false, 'отказа не было');
  } catch (e) {
    check(name, e instanceof kind, e instanceof Error ? e.message : String(e));
  }
}

const iso = () => new Date().toISOString();

async function seedAgent(db: D1Database, name: string, role = 'agent') {
  const id = crypto.randomUUID();
  await db.prepare(
    `insert into agents (id, email, full_name, role, status, created_at, updated_at)
     values (?, ?, ?, ?, 'approved', ?, ?)`,
  ).bind(id, `${name}@example.kg`, name, role, iso(), iso()).run();
  return id;
}

/** Войти тем же путём, что и браузер: строка в sessions плюс cookie. */
async function loginAs(db: D1Database, agentId: string) {
  const token = crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

  await db.prepare(
    `insert into sessions (token_hash, agent_id, created_at, expires_at, seen_at)
     values (?, ?, ?, ?, ?)`,
  ).bind(hash, agentId, iso(), new Date(Date.now() + 3600_000).toISOString(), iso()).run();

  resetCookies();
  setCookie(SESSION_COOKIE, token);
}

export default {
  async fetch(
    _request: Request,
    env: { DB: D1Database; PHOTOS: R2Bucket; CATALOG: D1Database },
  ): Promise<Response> {
    setEnv(env as unknown as Record<string, unknown>);
    results.length = 0;

    const db = env.DB;
    try {
    const anna = await seedAgent(db, 'anna');
    const boris = await seedAgent(db, 'boris');
    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Инвариант 1: публикация только при активном мандате
    // -----------------------------------------------------------------
    const obj = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Чүй 120',
      price_minor: 55_000_000, owner_name: 'Собственник', owner_phone: '0700 11 22 33',
    });
    check('объект рождается черновиком', obj.publication_state === 'draft');

    await throws('инв.1: публикация без мандата отклонена',
      () => publishObject(obj.id), Conflict);

    const mandate = await createMandate({ object_id: obj.id, kind: 'non_exclusive' });
    const published = await publishObject(obj.id);
    check('инв.1: с мандатом публикуется', published.publication_state === 'published');
    check('инв.5: published_at проставлен', published.published_at !== null);

    await throws('инв.1: второй активный мандат отклонён',
      () => createMandate({ object_id: obj.id, kind: 'exclusive' }), Conflict);

    // Условия комиссии правятся на действующем договоре: их уточняют
    // чаще, чем заключают договор заново, и расторгать ради этого
    // мандат значило бы снимать объект с публикации.
    const withTerms = await setMandateTerms(mandate.id, {
      commission_rule: JSON.stringify({ kind: 'percent', value: 3 }),
      partner_rate: 1.5,
    });
    check('условия комиссии правятся без расторжения договора',
      withTerms.partner_rate === 1.5 && withTerms.status === 'active');

    await throws('процент партнёра больше ста не принимается',
      () => setMandateTerms(mandate.id, { partner_rate: 140 }), Invalid);

    // -----------------------------------------------------------------
    // Инвариант 5: даты
    // -----------------------------------------------------------------
    const firstPublished = published.published_at;
    const beforeActual = published.actual_at;

    await withdrawObject(obj.id);
    const again = await publishObject(obj.id);
    check('инв.5: повторная публикация хранит первую дату',
      again.published_at === firstPublished,
      `было ${firstPublished}, стало ${again.published_at}`);

    const repriced = await updateObject(obj.id, { price_minor: 60_000_000 });
    check('инв.5: правка цены поднимает актуальность',
      repriced.actual_at > beforeActual);
    check('инв.5: правка цены не трогает дату публикации',
      repriced.published_at === firstPublished);

    const addressOnly = await updateObject(obj.id, { address: 'Чүй 121' });
    check('инв.5: правка адреса актуальность НЕ поднимает',
      addressOnly.actual_at === repriced.actual_at);

    const confirmed = await confirmActual(obj.id);
    check('инв.5: подтверждение поднимает актуальность',
      confirmed > repriced.actual_at);

    // -----------------------------------------------------------------
    // Инвариант 1: мандат снят — объект уходит из каталога
    // -----------------------------------------------------------------
    await terminateMandate(mandate.id, 'собственник передумал');
    const afterRelease = await getObject(obj.id);
    check('инв.1: расторжение снимает объект с публикации',
      afterRelease?.publication_state === 'withdrawn',
      `состояние: ${afterRelease?.publication_state}`);

    // Истечение по дате: мандат заводится сегодняшним днём, затем срок
    // сдвигается в прошлое прямой записью — так же, как это делает время.
    const m2 = await createMandate({ object_id: obj.id, kind: 'non_exclusive' });
    await publishObject(obj.id);
    // Срок двигается вместе с началом: схема не даёт сроку кончиться раньше,
    // чем договор начался, и это правильно — такой мандат бессмыслен.
    await db.prepare('update mandates set valid_from = ?, valid_to = ? where id = ?')
      .bind('2000-01-01', '2000-06-01', m2.id).run();

    const expired = await expireMandates();
    const afterExpiry = await getObject(obj.id);
    check('инв.1: истёкший мандат гасится', expired === 1, `погашено: ${expired}`);
    check('инв.1: истечение снимает объект с публикации',
      afterExpiry?.publication_state === 'withdrawn',
      `состояние: ${afterExpiry?.publication_state}`);

    // -----------------------------------------------------------------
    // Права: чужой объект правит только свой агент
    // -----------------------------------------------------------------
    await loginAs(db, boris);
    await throws('чужой объект править нельзя',
      () => updateObject(obj.id, { price_minor: 1 }), Forbidden);
    await throws('чужой объект публиковать нельзя',
      () => publishObject(obj.id), Forbidden);

    // -----------------------------------------------------------------
    // Инвариант 4: телефон собственника
    // -----------------------------------------------------------------
    const owner = await db.prepare(
      'select contact_id from object_ownerships where object_id = ?',
    ).bind(obj.id).first<{ contact_id: string }>();

    check('инв.4: посторонний контакт не видит',
      owner ? !(await canSeeContact(owner.contact_id)) : false);

    await loginAs(db, anna);
    check('инв.4: приведший контакт видит',
      owner ? await canSeeContact(owner.contact_id) : false);

    // -----------------------------------------------------------------
    // Контакты: один человек — одна запись
    // -----------------------------------------------------------------
    const ivan = await createContact({ name: 'Иван', phone: '0555 10 20 30' });
    check('контакт заводится с телефоном', ivan.name === 'Иван');

    const sameNumber = await findContactByPhone('+996555102030');
    check('поиск по другому написанию находит ту же запись',
      sameNumber.found && sameNumber.contact_id === ivan.id);

    await throws('второй контакт с тем же номером отклонён',
      () => createContact({ name: 'Иван ещё раз', phone: '+996 555 10 20 30' }),
      Conflict);

    // -----------------------------------------------------------------
    // Поиск дубликатов: правило имени
    // -----------------------------------------------------------------
    // Чистое правило — без базы. Здесь дешевле всего перечислить случаи.
    const sameName: Array<[string, string]> = [
      ['Орозов Нурлан', 'орозов нурлан'],
      // Главный случай: lower() в SQLite кириллицу НЕ приводит, поэтому
      // прежнее сравнение в запросе этих двоих дубликатами не считало.
      ['ОРОЗОВ НУРЛАН', 'Орозов Нурлан'],
      ['Орозов  Нурлан ', 'Орозов Нурлан'],
      ['Орозов Нурлан', 'Орозов Н.'],
      ['Орозов Н.', 'Орозов Нурлан Азаматович'],
      ['Этажи', 'ЭТАЖИ'],
    ];
    for (const [a, b] of sameName) {
      check(`«${a}» и «${b}» — одно лицо`, looksLikeSameName(a, b));
      check(`и наоборот: «${b}» и «${a}»`, looksLikeSameName(b, a));
    }

    const otherName: Array<[string, string]> = [
      ['Орозов Нурлан', 'Орозов Азамат'],
      ['Орозов Нурлан', 'Асанов Нурлан'],
      // Однофамильцев больше, чем тёзок, а объединение необратимо:
      // присоединённая запись удаляется. Лучше не предложить, чем склеить.
      ['Орозов', 'Орозов Нурлан'],
      ['Орозов Нурлан Азаматович', 'Орозов Нурлан Асанович'],
      ['', 'Орозов Нурлан'],
    ];
    for (const [a, b] of otherName) {
      check(`«${a}» и «${b}» — разные`, !looksLikeSameName(a, b));
      check(`и наоборот тоже разные: «${b}» и «${a}»`, !looksLikeSameName(b, a));
    }

    // Две пустые строки равны друг другу, и без отдельной проверки на
    // пустоту правило сочло бы их одним лицом. В базе имя пустым быть не
    // может (есть ограничение), но правило отвечает и на то, что в базу
    // ещё не попало — например, на ввод в форме.
    check('две пустые строки — не одно лицо', !looksLikeSameName('', ''));
    check('и пробелы с точками тоже', !looksLikeSameName('  ', ' . '));

    check('приведение имени схлопывает регистр, пробелы и точки',
      nameKey('  ОРОЗОВ   Н. ') === 'орозов н', `получилось «${nameKey('  ОРОЗОВ   Н. ')}»`);

    // А теперь то же через базу: кандидаты для конкретной записи.
    const capsDupe = await createContact({ name: 'ИВАН', phone: '0555 10 20 31' });
    const initials = await createContact({ name: 'Иван И.', phone: '0555 10 20 32' });
    await createContact({ name: 'Пётр Петров', phone: '0555 10 20 33' });

    const candidates = await duplicatesOf(ivan.id);
    const ids = candidates.map((c) => c.other_id);
    check('капсом записанный тот же человек попадает в кандидаты',
      ids.includes(capsDupe.id));
    check('а однофамилец с другим именем — нет',
      !candidates.some((c) => c.other_name === 'Пётр Петров'));
    // «Иван» — одно слово, «Иван И.» — два: по правилу это НЕ совпадение.
    check('и «Иван» с «Иван И.» не склеиваются',
      !ids.includes(initials.id));

    // Чужие записи в кандидаты не идут даже при полном совпадении имени.
    await loginAs(db, boris);
    const hisIvan = await createContact({ name: 'Иван', phone: '0555 10 20 34' });
    await loginAs(db, anna);
    check('чужой контакт с тем же именем в кандидаты не попадает',
      !(await duplicatesOf(ivan.id)).some((c) => c.other_id === hisIvan.id));

    // Список пар — то же правило, что у подсказки на карточке. Разные
    // правила означали бы, что в одном месте дубликат есть, в другом нет.
    const pairs = await contactDuplicates();
    check('список пар видит «Иван» и «ИВАН»',
      pairs.some((pr) =>
        (pr.a_id === ivan.id && pr.b_id === capsDupe.id)
        || (pr.a_id === capsDupe.id && pr.b_id === ivan.id)));
    check('и не выдумывает пару с «Пётр Петров»',
      !pairs.some((pr) => pr.a_name === 'Пётр Петров' || pr.b_name === 'Пётр Петров'));

    // Пара, которую видно ТОЛЬКО по правилу инициалов. Без неё проверка
    // проходила бы и на простом сравнении строк в нижнем регистре —
    // toLowerCase() в JS, в отличие от lower() в SQLite, кириллицу
    // приводит, и капсом записанную пару поймало бы и оно. Проверено
    // мутацией: подмени правило на такое сравнение — падает эта строка.
    const full = await createContact({
      name: 'Токтогулов Азамат', phone: '0555 10 20 36',
    });
    const short = await createContact({
      name: 'Токтогулов А.', phone: '0555 10 20 37',
    });
    const withInitials = await contactDuplicates();
    check('список пар видит «Токтогулов Азамат» и «Токтогулов А.»',
      withInitials.some((pr) =>
        (pr.a_id === full.id && pr.b_id === short.id)
        || (pr.a_id === short.id && pr.b_id === full.id)));

    // -----------------------------------------------------------------
    // Объединение: порядок шагов и потеря данных
    // -----------------------------------------------------------------
    // Главный случай — запись БЕЗ связей с объектами. При неправильном
    // порядке RESTRICT промолчит, и потребности исчезнут без единой ошибки.
    const dupe = await createContact({ name: 'Иван Иванов', phone: '0555 40 50 60' });

    // Обе записи — собственники ОДНОГО объекта в ОДНОЙ роли. Роль входит
    // в ключ связи, поэтому при объединении лишняя связь снимается
    // навсегда. Это единственное, что объединение действительно теряет, и
    // в журнале должно остаться, ЧТО именно снято, а не только сколько.
    await setObjectOwnership(obj.id, ivan.id, 'owner');
    await setObjectOwnership(obj.id, dupe.id, 'owner');
    await db.prepare(
      `insert into requirements (id, contact_id, deal_type, agent_id, status,
                                 created_at, updated_at)
       values (?, ?, 'sale', ?, 'new', ?, ?)`,
    ).bind(crypto.randomUUID(), dupe.id, anna, iso(), iso()).run();

    const report = await mergeContacts(ivan.id, dupe.id);
    const reqAfter = await db.prepare(
      'select count(*) as n from requirements where contact_id = ?',
    ).bind(ivan.id).first<{ n: number }>();
    const gone = await db.prepare('select count(*) as n from requirements')
      .first<{ n: number }>();

    // Присоединённая запись удаляется без возможности вернуть, и журнал —
    // единственное место, где её содержимое остаётся. До этого там лежало
    // ОДНО ИМЯ, хотя README обещал содержимое: по имени запись не собрать.
    const mergedAudit = await db.prepare(
      `select diff from audit_log
        where entity_type = 'contacts' and entity_id = ? and action = 'delete'
        order by id desc limit 1`,
    ).bind(dupe.id).first<{ diff: string }>();
    const buried = JSON.parse(mergedAudit?.diff ?? '{}') as Record<string, unknown>;

    check('журнал хранит имя удалённой записи', buried.name === 'Иван Иванов');
    check('и её вид', buried.kind === 'person');
    check('и владельца', buried.owner_agent_id === anna);
    check('и дату появления', typeof buried.created_at === 'string');
    check('и куда её влили', buried.merged_into === ivan.id);
    // Телефонов в журнале быть не должно: они не удаляются, а переезжают.
    check('а телефонов в журнале нет', !('phones' in buried) && !('phone' in buried));

    const dropped = buried.dropped_ownerships as Array<{ object_id: string; role: string }>;
    check('и снятая связь собственности выписана целиком',
      Array.isArray(dropped) && dropped.length === 1
      && dropped[0]?.object_id === obj.id && dropped[0]?.role === 'owner',
      JSON.stringify(dropped));
    check('а отчёт об объединении её посчитал', report.ownerships_dropped === 1,
      `снято ${report.ownerships_dropped}`);

    check('объединение переносит потребность, а не теряет её',
      (reqAfter?.n ?? 0) === 1 && (gone?.n ?? 0) === 1,
      `у остающейся ${reqAfter?.n}, всего ${gone?.n}`);
    check('объединение переносит телефоны', report.phones === 1);

    const phones = await contactPhones(ivan.id);
    check('после объединения оба номера у одной записи', phones.length === 2);
    check('основной номер ровно один',
      phones.filter((p) => p.is_primary === 1).length === 1);

    // Чужие записи объединять нельзя.
    const hers = await createContact({ name: 'Клиент Анны', phone: '0777 11 11 11' });
    await loginAs(db, boris);
    const his = await createContact({ name: 'Клиент Бориса', phone: '0777 22 22 22' });
    await throws('объединять чужую запись нельзя',
      () => mergeContacts(his.id, hers.id), Forbidden);

    // -----------------------------------------------------------------
    // Поиск по имени и по тексту: та же ловушка lower()
    // -----------------------------------------------------------------
    // Предыдущий блок закончился входом Бориса, а контакты здесь — Анны.
    await loginAs(db, anna);

    // Ищем строчными то, что записано с большой буквы. На lower() в
    // запросе это не работало: кириллицу он не приводит.
    const foundLower = await contactList('пётр');
    check('поиск контакта строчными находит запись с заглавной',
      foundLower.rows.some((c) => c.name === 'Пётр Петров'),
      `нашлось ${foundLower.rows.length}`);

    const foundCaps = await contactList('ПЁТР');
    check('и заглавными тоже находит',
      foundCaps.rows.some((c) => c.name === 'Пётр Петров'));

    check('а чужого по имени поиск не выдаёт',
      !(await contactList('иван')).rows.some((c) => c.id === hisIvan.id));

    // Текст потребности: ищем «Тёплый», записано «ТЁПЛЫЙ балкон».
    // На отдельном контакте, а не на ivan: его объединяют ниже, и лишняя
    // потребность сбила бы проверку переноса.
    const searchClient = await createContact({
      name: 'Поисковый Клиент', phone: '0555 10 20 35',
    });
    const searchNeed = await createRequirement({
      contact_id: searchClient.id, deal_type: 'sale',
      requirements_text: 'ТЁПЛЫЙ балкон и Чүй рядом',
    });
    const needFound = await requirementList({ q: 'тёплый' });
    check('поиск по тексту потребности не зависит от регистра',
      needFound.rows.some((r) => r.id === searchNeed.id),
      `нашлось ${needFound.rows.length}`);

    // Кыргызская буква сводится к русской — как у адресов объектов.
    check('и «чуй» находит «Чүй»',
      (await requirementList({ q: 'чуй' })).rows.some((r) => r.id === searchNeed.id));

    // Правка текста переносит и поисковую колонку: иначе потребность
    // находилась бы по прежнему тексту и не находилась по новому.
    await updateRequirement(searchNeed.id, { requirements_text: 'ХОЛОДНАЯ лоджия' });
    check('после правки находится по новому тексту',
      (await requirementList({ q: 'холодная' })).rows.some((r) => r.id === searchNeed.id));
    check('и по прежнему уже не находится',
      !(await requirementList({ q: 'тёплый' })).rows.some((r) => r.id === searchNeed.id));

    // То же для имени контакта.
    await updateContact(capsDupe.id, { name: 'СИДОРОВ Пётр' });
    check('переименованный контакт находится по новому имени',
      (await contactList('сидоров')).rows.some((c) => c.id === capsDupe.id));
    check('и по прежнему имени больше нет',
      !(await contactList('иван')).rows.some((c) => c.id === capsDupe.id));

    // Порядок списка: SQLite сравнивает побайтно, и для кириллицы это
    // значит, что все заглавные идут перед всеми строчными. Проверено
    // запросом к боевой базе: «Абрамов, Орозов, Яковлев, абрамов,
    // яковлев». Значит контакт, записанный строчными, уезжал в конец.
    // Пара выбрана так, чтобы побайтный порядок РАСХОДИЛСЯ с алфавитным:
    // строчная «а» это U+0430, заглавная «Я» — U+042F, то есть побайтно
    // «Яковлев» идёт ПЕРЕД «абрамов», хотя по алфавиту наоборот. Пара
    // «Абрамов»/«яблоков» для этого не годится: там оба порядка совпадают,
    // и проверка проходила бы на сломанной сортировке — проверено
    // мутацией, она так и прошла.
    await createContact({ name: 'абрамов Клиент', phone: '0555 10 20 38' });
    await createContact({ name: 'Яковлев Клиент', phone: '0555 10 20 39' });

    const order = (await contactList(null, 'name', 'asc')).rows.map((c) => c.name);
    const abramov = order.indexOf('абрамов Клиент');
    const yakovlev = order.indexOf('Яковлев Клиент');
    check('строчный «абрамов» идёт раньше заглавного «Яковлева»',
      abramov >= 0 && yakovlev >= 0 && abramov < yakovlev,
      `порядок: ${order.join(' | ')}`);

    // И наоборот — иначе проверка проходила бы на любом устойчивом
    // порядке, хоть бы и на обратном.
    const desc = (await contactList(null, 'name', 'desc')).rows.map((c) => c.name);
    check('а в обратном порядке — позже',
      desc.indexOf('Яковлев Клиент') < desc.indexOf('абрамов Клиент'),
      `порядок: ${desc.join(' | ')}`);

    // -----------------------------------------------------------------
    // Курс Нацбанка: разбор ответа
    // -----------------------------------------------------------------
    // Ответ взят с www.nbkr.kg/XML/daily.xml как есть, вместе с
    // объявлением кодировки и запятой в числе.
    const nbkr = `<?xml version="1.0" encoding="windows-1251" ?>
<CurrencyRates Name="Daily Exchange Rates" Date="28.11.2026">
<Currency ISOCode="USD">
<Nominal>1</Nominal>
<Value>87,4500</Value>
</Currency>
<Currency ISOCode="KZT">
<Nominal>100</Nominal>
<Value>19,0900</Value>
</Currency>
</CurrencyRates>`;

    const snap = parseNbkr(nbkr);
    check('курс разобран', Boolean(snap));
    check('дата приведена к ISO', snap?.asOf === '2026-11-28', String(snap?.asOf));

    // ГЛАВНОЕ. Разделитель у Нацбанка — ЗАПЯТАЯ, и parseFloat('87,4500')
    // молча возвращает 87. Курс занизился бы в сто раз, цены в сомах
    // вышли бы втрое меньше правды, и поймать это можно только глазами.
    const usd = snap?.rates.find((r) => r.code === 'USD');
    check('запятая прочитана как десятичный разделитель',
      usd?.somPerUnit === 87.45, String(usd?.somPerUnit));

    // Значение относится к Nominal единицам, а не к одной.
    const kzt = snap?.rates.find((r) => r.code === 'KZT');
    check('номинал учтён: 100 тенге по 19,09 — это 0,1909 за тенге',
      Math.abs((kzt?.somPerUnit ?? 0) - 0.1909) < 1e-9, String(kzt?.somPerUnit));

    check('мусор вместо ответа — пусто, а не ноль', parseNbkr('не xml') === null);
    check('ответ без даты не принимается',
      parseNbkr('<CurrencyRates><Currency ISOCode="USD"><Nominal>1</Nominal>'
        + '<Value>87,45</Value></Currency></CurrencyRates>') === null);

    // Пересчёт.
    check('доллары в сомы', convert(100, 'USD', 'KGS', 87.45) === 8745);
    check('сомы в доллары',
      Math.abs((convert(8745, 'KGS', 'USD', 87.45) ?? 0) - 100) < 1e-9);
    check('своя валюта возвращается как есть', convert(100, 'USD', 'USD', 87.45) === 100);
    // Без курса пересчёта нет. Это не «примерно столько» — это неправда.
    check('без курса пересчёта нет', convert(100, 'USD', 'KGS', null) === null);
    check('нулевой курс не принимается', convert(100, 'USD', 'KGS', 0) === null);
    check('третья валюта без курса — пусто', convert(100, 'EUR', 'KGS', 87.45) === null);

    // -----------------------------------------------------------------
    // WhatsApp: кнопка ведёт в переписку с готовым сообщением
    // -----------------------------------------------------------------
    const LABELS = { call: 'Позвонить', whatsapp: 'WhatsApp', telegram: 'Telegram' };
    const withWa = { phone: '0700 11 22 33', whatsapp: 1, telegram_user: null };

    const wa = contactLinks(withWa, LABELS,
      'Добрый день! Объект: Чүй 120, 55 000 $.\nhttps://liberterra.kg/ru/objects/abc')
      .find((l) => l.kind === 'whatsapp');

    check('ссылка ведёт на wa.me с международным номером',
      wa?.href.startsWith('https://wa.me/996700112233?text=') === true, String(wa?.href));

    // Текст обязан быть закодирован: пробелы, перенос строки и ссылка
    // внутри параметра иначе обрежут сообщение по первому же знаку,
    // который браузер прочтёт как служебный.
    check('пробелы закодированы', wa?.href.includes('%20') === true);
    check('перенос строки закодирован', wa?.href.includes('%0A') === true);
    check('в ссылке нет сырых пробелов', !/ /.test(wa?.href ?? ' '));
    check('и текст восстанавливается обратно',
      decodeURIComponent((wa?.href ?? '').split('text=')[1] ?? '')
        .includes('Чүй 120, 55 000 $'));

    // Без текста — обычная ссылка, без хвоста.
    const bare = contactLinks(withWa, LABELS).find((l) => l.kind === 'whatsapp');
    check('без сообщения ссылка остаётся чистой',
      bare?.href === 'https://wa.me/996700112233', String(bare?.href));
    check('пустое сообщение хвоста не добавляет',
      contactLinks(withWa, LABELS, '   ').find((l) => l.kind === 'whatsapp')?.href
        === 'https://wa.me/996700112233');

    // Агент не отметил WhatsApp — кнопки нет, сколько ни передавай текст.
    check('без отметки кнопки WhatsApp нет',
      !contactLinks({ phone: '0700 11 22 33', whatsapp: 0, telegram_user: null },
        LABELS, 'текст').some((l) => l.kind === 'whatsapp'));

    check('номер приводится к международному виду',
      phoneDigits('0700 11 22 33') === '996700112233');

    // -----------------------------------------------------------------
    // Порог рынка: заявку ниже самого дешёвого объявления не принимаем
    // -----------------------------------------------------------------
    // Пять однокомнатных в Джале по 30 000–50 000 сом. Пять — ровно
    // столько, сколько нужно, чтобы порог вообще появился.
    await loginAs(db, anna);
    const market: string[] = [];
    for (const price of [30_000_00, 35_000_00, 40_000_00, 45_000_00, 50_000_00]) {
      const o = await createObject({
        kind: 'flat', deal_type: 'rent', address: `Джалская ${price}`,
        zone: 'Джал', price_minor: price, currency: 'KGS',
      });
      await createMandate({ object_id: o.id, kind: 'non_exclusive' });
      await publishObject(o.id);
      market.push(o.id);
    }

    const floor = await priceFloor({ deal: 'rent', kind: 'flat', zone: 'Джал' });
    check('порог равен самой дешёвой цене, а не средней',
      floor?.floor_minor === 30_000_00, String(floor?.floor_minor));
    check('и видно, по скольки объявлениям он посчитан',
      floor?.based_on === 5, String(floor?.based_on));
    check('валюта порога — валюта объявлений', floor?.currency === 'KGS');

    // Мало данных — порога нет. Запрет по незнанию хуже отсутствия
    // запрета: в этом срезе рынок нам неизвестен.
    //
    // Район с ТРЕМЯ объявлениями, а не с нулём: на нуле проверка прошла бы
    // и без порога по числу — порога там нет просто потому, что нечего
    // считать. Это показала мутация.
    const thin: string[] = [];
    for (const price of [60_000_00, 70_000_00, 80_000_00]) {
      const o = await createObject({
        kind: 'flat', deal_type: 'rent', address: `Тонкая ${price}`,
        zone: 'Тонкий', price_minor: price, currency: 'KGS',
      });
      await createMandate({ object_id: o.id, kind: 'non_exclusive' });
      await publishObject(o.id);
      thin.push(o.id);
    }
    check('по трём объявлениям порога нет — выборка слишком мала',
      (await priceFloor({ deal: 'rent', kind: 'flat', zone: 'Тонкий' })) === null);
    check('и такая заявка проходит',
      Boolean(await submitRequest({
        phone: '0555 77 66 52', deal: 'rent', housing_type: 'flat',
        district: 'Тонкий', budget_minor: 1_000_00, budget_currency: 'KGS',
      })));
    for (const id of thin) {
      await db.prepare('delete from mandates where object_id = ?').bind(id).run();
      await db.prepare('delete from objects where id = ?').bind(id).run();
    }

    check('и по виду жилья, которого в каталоге нет',
      (await priceFloor({ deal: 'rent', kind: 'garage', zone: 'Джал' })) === null);

    // Заявка ниже порога не принимается, и отказ несёт ЧИСЛА: форме нужен
    // порог и число объявлений, а не фраза, из которой их не достать.
    let low: unknown = null;
    try {
      await submitRequest({
        phone: '0555 77 66 55', deal: 'rent', housing_type: 'flat',
        district: 'Джал', budget_minor: 20_000_00, budget_currency: 'KGS',
      });
    } catch (e) { low = e; }

    check('заявка с бюджетом ниже рынка отклонена', low instanceof BudgetTooLow);
    check('и в отказе есть сам порог',
      (low as BudgetTooLow)?.floor === 30_000, String((low as BudgetTooLow)?.floor));
    check('и число объявлений, на которых он стоит',
      (low as BudgetTooLow)?.basedOn === 5);

    // А ровно по порогу — принимается: «дешевле нет» не значит «нет».
    // Через try: если порог начнёт отсекать и равные, исключение оборвало
    // бы прогон раньше этой строки, и красный прогон сказал бы «что-то
    // упало» вместо «порог отсекает лишнее».
    let atFloor: string | null = null;
    let atFloorWhy: string | null = null;
    try {
      atFloor = await submitRequest({
        phone: '0555 77 66 54', deal: 'rent', housing_type: 'flat',
        district: 'Джал', budget_minor: 30_000_00, budget_currency: 'KGS',
      });
    } catch (e) { atFloorWhy = e instanceof Error ? e.message : String(e); }
    check('заявка ровно по порогу принимается', Boolean(atFloor), atFloorWhy ?? '');

    // Бюджет в другой валюте порогом не отсекается: сравнивать 200
    // долларов с 30 000 сомов как числа нельзя, а курса у витрины может и
    // не быть. Лучше принять заявку, чем отказать по неверному сравнению.
    let otherMoney: string | null = null;
    let otherWhy: string | null = null;
    try {
      otherMoney = await submitRequest({
        phone: '0555 77 66 53', deal: 'rent', housing_type: 'flat',
        district: 'Джал', budget_minor: 200_00, budget_currency: 'USD',
      });
    } catch (e) { otherWhy = e instanceof Error ? e.message : String(e); }
    check('бюджет в другой валюте порогом не отсекается',
      Boolean(otherMoney), otherWhy ?? '');

    for (const id of market) {
      await db.prepare('delete from mandates where object_id = ?').bind(id).run();
      await db.prepare('delete from objects where id = ?').bind(id).run();
    }

    // -----------------------------------------------------------------
    // Застоявшаяся заявка: бот пишет агенту, который её взял
    // -----------------------------------------------------------------
    await loginAs(db, anna);
    // Без привязанного Telegram доставлять нечем, и агент в выборку не
    // попадает вовсе. Привязываем на время этой проверки и снимаем в
    // конце — ниже на этом стоит отдельная строка.
    await db.prepare('update agents set telegram_id = ? where id = ?')
      .bind(700100200, anna).run();

    const idleReq = await submitRequest({
      phone: '0555 33 22 11', name: 'Айбек', deal: 'rent', housing_type: 'flat',
      district: 'Джал', budget_minor: 15_000_00, budget_currency: 'KGS',
    });
    await takeRequest(idleReq);

    // Только что взятая заявка напоминания не даёт: сутки ещё не прошли.
    check('свежая заявка в напоминания не идёт',
      !(await idleRequests()).some((n) => n.request_id === idleReq));

    // Отматываем взятие на двое суток назад.
    await db.prepare('update requests set taken_at = ? where id = ?')
      .bind(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), idleReq).run();

    const nudges = await idleRequests();
    const mine3 = nudges.find((n) => n.request_id === idleReq);
    check('застоявшаяся заявка даёт напоминание', Boolean(mine3));
    check('и оно адресовано тому, кто её взял', mine3?.agent_id === anna);
    check('в тексте есть клиент', mine3?.body.includes('Айбек') === true, mine3?.body);
    check('и бюджет', mine3?.body.includes('15000') === true, mine3?.body);

    // Напоминание уходит ОДИН раз: отметка ставится после доставки.
    await markRequestNudged(idleReq);
    check('после отметки напоминание не повторяется',
      !(await idleRequests()).some((n) => n.request_id === idleReq));

    // Если в каталоге есть подходящее — напоминать не о чем.
    //
    // Объект заводится ЗДЕСЬ, а не предполагается: первая версия
    // проверки опиралась на то, что в каталоге «наверняка что-то есть»
    // — и упала, потому что подходящего там не было. Проверка, стоящая
    // на допущении о чужих данных, проверяет не то, что обещает.
    const forHim = await createObject({
      kind: 'flat', deal_type: 'rent', address: 'Подходящая 1',
      zone: 'Центр', price_minor: 500_00, currency: 'USD',
    });
    await createMandate({ object_id: forHim.id, kind: 'non_exclusive' });
    await publishObject(forHim.id);

    const matchable = await submitRequest({
      phone: '0555 33 22 10', deal: 'rent', housing_type: 'flat',
      district: 'Центр', budget_minor: 1_000_00, budget_currency: 'USD',
    });
    await takeRequest(matchable);
    await db.prepare('update requests set taken_at = ? where id = ?')
      .bind(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), matchable).run();
    check('по заявке с подходящим вариантом напоминания нет',
      !(await idleRequests()).some((n) => n.request_id === matchable),
      'в каталоге есть аренда в Центре дешевле 1000 $');

    await db.prepare('delete from mandates where object_id = ?').bind(forHim.id).run();
    await db.prepare('delete from objects where id = ?').bind(forHim.id).run();

    // Агенту без Telegram доставить нечем — в список он не попадает вовсе,
    // а не попадает и падает при отправке.
    await db.prepare('update agents set telegram_id = null where id = ?').bind(anna).run();
    const noTg = await submitRequest({
      phone: '0555 33 22 12', deal: 'rent', housing_type: 'flat',
      district: 'Джал', budget_minor: 15_000_00, budget_currency: 'KGS',
    });
    await takeRequest(noTg);
    await db.prepare('update requests set taken_at = ? where id = ?')
      .bind(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), noTg).run();
    check('агенту без Telegram напоминание не собирается',
      !(await idleRequests()).some((n) => n.request_id === noTg));

    // -----------------------------------------------------------------
    // Непринятая заявка: одно сообщение всем, и не ночью
    // -----------------------------------------------------------------
    await db.prepare('update agents set telegram_id = ? where id = ?')
      .bind(700100200, anna).run();
    // Чистим поле: предыдущие блоки оставили заявки в разных состояниях.
    await db.prepare(`update requests set unclaimed_notified_at = ?`).bind(iso()).run();

    const noon = new Date('2026-11-27T06:00:00.000Z');   // 12:00 в Бишкеке
    const night = new Date('2026-11-27T20:00:00.000Z');  // 02:00 в Бишкеке

    const waiting1 = await submitRequest({
      phone: '0555 10 10 01', deal: 'rent', housing_type: 'flat',
      district: 'Джал', budget_minor: 40_000_00, budget_currency: 'KGS',
    });
    const waiting2 = await submitRequest({
      phone: '0555 10 10 02', deal: 'buy', housing_type: 'house',
    });
    await db.prepare(
      `update requests set created_at = ?, unclaimed_notified_at = null where id in (?, ?)`,
    ).bind(new Date(noon.getTime() - 3 * 3600 * 1000).toISOString(),
           waiting1, waiting2).run();

    const digest = await unclaimedRequests(2 * 3600 * 1000, noon);
    check('непринятые заявки собираются в ОДНО сообщение', Boolean(digest));
    check('и в нём обе', digest?.request_ids.length === 2,
      String(digest?.request_ids.length));
    check('получатель — агент с привязанным Telegram',
      digest?.recipients.some((r) => r.agent_id === anna) === true);
    check('в тексте видно, сколько заявка ждёт',
      digest?.body.includes('ждёт 3 ч') === true, digest?.body);

    // Ночью бот молчит — и НЕ отмечает заявки: иначе утром о них никто не
    // узнает. Это важнее самой тишины.
    check('ночью напоминания нет',
      (await unclaimedRequests(2 * 3600 * 1000, night)) === null);
    check('и заявки при этом не отмечены как отработанные',
      (await unclaimedRequests(2 * 3600 * 1000, noon))?.request_ids.length === 2);

    // Свежая заявка не торопит: два часа ещё не прошло.
    const justNow = await submitRequest({ phone: '0555 10 10 03', deal: 'rent' });
    await db.prepare('update requests set unclaimed_notified_at = null where id = ?')
      .bind(justNow).run();
    check('заявка моложе двух часов в сводку не идёт',
      !(await unclaimedRequests(2 * 3600 * 1000, noon))?.request_ids.includes(justNow));

    // Взятая заявка — не непринятая.
    await takeRequest(waiting1);
    check('взятая заявка из сводки уходит',
      !(await unclaimedRequests(2 * 3600 * 1000, noon))?.request_ids.includes(waiting1));

    // Отметка гасит повтор.
    await markUnclaimedNudged([waiting2]);
    check('после отметки сводки нет',
      (await unclaimedRequests(2 * 3600 * 1000, noon)) === null);

    // Возвращаем как было: ниже стоит проверка «без привязанного Telegram
    // статус „нечем доставить"», и привязка, оставленная здесь, ломает её.
    await db.prepare('update agents set telegram_id = null where id = ?').bind(anna).run();

    // -----------------------------------------------------------------
    // Что ищут: словарь подробнее, срок аренды в днях
    // -----------------------------------------------------------------
    // Огрубление выводится ИЗ подробного типа. Иначе два поля разойдутся,
    // и заявка на кабинет окажется заявкой на квартиру.
    check('кабинет огрубляется до коммерческой', coarseOf('cabinet') === 'commercial');
    check('рабочее место — тоже', coarseOf('desk') === 'commercial');
    check('квартира остаётся квартирой', coarseOf('flat') === 'flat');
    check('выдуманный тип не огрубляется в чужой', coarseOf('дом-мечты') === null);
    check('у каждого вида есть группа',
      SPACE_TYPES.every((t) => ['housing', 'commercial', 'workplace'].includes(t.group)));

    const office = await submitRequest({
      phone: '0555 20 20 01', deal: 'rent', space_type: 'cabinet',
      term_days_min: 90, term_days_max: 180,
    });
    const officeRow = await db.prepare(
      'select space_type, housing_type, term_days_min, term_days_max from requests where id = ?',
    ).bind(office).first<{
      space_type: string; housing_type: string;
      term_days_min: number; term_days_max: number;
    }>();

    check('подробный тип сохранён как есть', officeRow?.space_type === 'cabinet');
    check('а огрублённый выведен из него',
      officeRow?.housing_type === 'commercial', String(officeRow?.housing_type));
    check('срок сохранён в днях',
      officeRow?.term_days_min === 90 && officeRow?.term_days_max === 180);

    // Перепутанные местами границы — опечатка, а не повод терять заявку.
    const swapped = await submitRequest({
      phone: '0555 20 20 02', deal: 'rent', space_type: 'flat',
      term_days_min: 180, term_days_max: 30,
    });
    const swappedRow = await db.prepare(
      'select term_days_min, term_days_max from requests where id = ?',
    ).bind(swapped).first<{ term_days_min: number; term_days_max: number }>();
    check('перепутанные границы срока меняются местами',
      swappedRow?.term_days_min === 30 && swappedRow?.term_days_max === 180,
      `${swappedRow?.term_days_min}–${swappedRow?.term_days_max}`);

    // У покупки срока не бывает: пришёл — значит мусор из формы.
    const bought = await submitRequest({
      phone: '0555 20 20 03', deal: 'buy', space_type: 'house',
      term_days_min: 30, term_days_max: 90,
    });
    const boughtRow = await db.prepare(
      'select term_days_min, term_days_max from requests where id = ?',
    ).bind(bought).first<{ term_days_min: number | null; term_days_max: number | null }>();
    check('у покупки срок не сохраняется',
      boughtRow?.term_days_min === null && boughtRow?.term_days_max === null);

    // Выдуманный тип не подменяет огрубление чужим значением.
    const weird = await submitRequest({
      phone: '0555 20 20 04', deal: 'rent', space_type: 'нечто',
    });
    check('выдуманный тип не сохраняется',
      (await db.prepare('select space_type from requests where id = ?')
        .bind(weird).first<{ space_type: string | null }>())?.space_type === null);

    check('курса в пустой базе нет', (await usdRate()) === null);
    check('и витрина его тоже не выдумывает', (await catalogRate()) === null);

    // Курс записывается и читается витриной вместе с датой: без даты
    // пересчёт нечестен — человек вправе знать, насколько он свежий.
    await db.prepare(
      `insert into fx_rates (code, som_per_unit, as_of, fetched_at)
       values ('USD', 87.45, '2026-11-28', ?)`,
    ).bind(iso()).run();
    check('витрина отдаёт курс', (await catalogRate())?.som_per_unit === 87.45);
    check('и дату, на которую он объявлен',
      (await catalogRate())?.as_of === '2026-11-28');

    // Нацбанк недоступен — прежний курс остаётся. Это главное свойство:
    // сайт показывает вчерашний курс с его датой, а не ноль и не падение.
    const kept = await refreshRates();
    check('неудачное подтягивание не трогает прежний курс',
      (await usdRate())?.som_per_unit === 87.45, `записано ${kept}`);

    // -----------------------------------------------------------------
    // Отбор и порядок по цене считают в выбранной валюте
    // -----------------------------------------------------------------
    // Два объекта: дешёвый в долларах и дорогой в сомах. Как ЧИСЛА они
    // идут в обратном порядке — 2 000 меньше 80 000, — и именно на этом
    // ломался фильтр, пока он сравнивал сырые числа.
    await loginAs(db, anna);
    const inUsd = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Долларовая 1',
      price_minor: 2_000_00, currency: 'USD',
    });
    const inSom = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Сомовая 1',
      price_minor: 80_000_00, currency: 'KGS',
    });
    for (const id of [inUsd.id, inSom.id]) {
      await createMandate({ object_id: id, kind: 'non_exclusive' });
      await publishObject(id);
    }

    const RATE = 87.45;  // 2 000 $ = 174 900 сом, то есть дороже 80 000 сом

    const cheapFirst = (await catalogPage({
      deal: 'sale', sort: 'cheap', money: 'KGS', rate: RATE, pageSize: 60,
    })).items.map((i) => i.address);
    check('сомовый объект дешевле долларового, и порядок это знает',
      cheapFirst.indexOf('Сомовая 1') < cheapFirst.indexOf('Долларовая 1'),
      cheapFirst.join(' | '));

    // А без курса порядок прежний, по сырым числам: 2 000 < 80 000.
    const noRate = (await catalogPage({
      deal: 'sale', sort: 'cheap', pageSize: 60,
    })).items.map((i) => i.address);
    check('без курса сравниваются сырые числа, как было',
      noRate.indexOf('Долларовая 1') < noRate.indexOf('Сомовая 1'),
      noRate.join(' | '));

    // Отбор: «до 100 000 сомов» должен взять сомовый и отбросить
    // долларовый, который в сомах стоит 174 900.
    const upTo = (await catalogPage({
      deal: 'sale', priceMax: 100_000, money: 'KGS', rate: RATE, pageSize: 60,
    })).items.map((i) => i.address);
    check('«до 100 000 сомов» берёт сомовый объект', upTo.includes('Сомовая 1'));
    check('и отбрасывает долларовый — он в сомах дороже',
      !upTo.includes('Долларовая 1'), upTo.join(' | '));

    // «До 3 000 долларов» — наоборот: долларовый проходит, сомовый
    // (915 долларов) тоже; а «до 500 долларов» не берёт ни одного.
    const upToUsd = (await catalogPage({
      deal: 'sale', priceMax: 3_000, money: 'USD', rate: RATE, pageSize: 60,
    })).items.map((i) => i.address);
    check('«до 3 000 долларов» берёт оба',
      upToUsd.includes('Долларовая 1') && upToUsd.includes('Сомовая 1'),
      upToUsd.join(' | '));

    const tiny = (await catalogPage({
      deal: 'sale', priceMax: 500, money: 'USD', rate: RATE, pageSize: 60,
    })).items.map((i) => i.address);
    check('«до 500 долларов» не берёт ни одного',
      !tiny.includes('Долларовая 1') && !tiny.includes('Сомовая 1'),
      tiny.join(' | '));

    // Прибираем: дальше считаются объекты, и два лишних собьют счётчики.
    for (const id of [inUsd.id, inSom.id]) {
      await db.prepare('delete from mandates where object_id = ?').bind(id).run();
      await db.prepare('delete from objects where id = ?').bind(id).run();
    }

    // -----------------------------------------------------------------
    // Выгрузка в CSV: файл не должен исполняться в Excel
    // -----------------------------------------------------------------
    // Значение, начинающееся с =, +, - или @, Excel и LibreOffice считают
    // формулой. Заметка агента «=HYPERLINK(...)» стала бы в файле ссылкой,
    // по которой кто-то щёлкнет. Защита была, проверки на неё — не было.
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1']) {
      const csv = toCsv(['Заметка'], [[dangerous]]);
      check(`значение «${JSON.stringify(dangerous)}» обезврежено апострофом`,
        csv.includes(`'${dangerous}`) || csv.includes(`"'${dangerous}`),
        csv);
    }

    const plain = toCsv(['Имя'], [['Орозов Нурлан']]);
    check('обычное значение апострофом не портится',
      plain.includes('Орозов Нурлан') && !plain.includes("'Орозов"), plain);

    // Метка порядка байтов и переводы строк: без них Excel в русской
    // локали открывает файл кракозябрами и одной колонкой.
    const shaped = toCsv(['А', 'Б'], [['1', '2']]);
    check('файл начинается с метки порядка байтов', shaped.charCodeAt(0) === 0xfeff);
    check('строки разделены CRLF', shaped.includes('\r\n'));
    check('колонки разделены точкой с запятой', shaped.includes('А;Б'));

    // Кавычки и разделители внутри значения.
    const tricky = toCsv(['Заметка'], [['он сказал "да"; потом ушёл']]);
    check('кавычки удваиваются и значение берётся в кавычки',
      tricky.includes('"он сказал ""да""; потом ушёл"'), tricky);

    const breaks = toCsv(['Заметка'], [['первая\nвторая']]);
    check('перенос строки внутри значения не разрывает строку файла',
      breaks.includes('"первая\nвторая"'), breaks);

    // Строго: пустая строка целиком, а не «где-то есть переводы строк».
    const empties = toCsv(['А', 'Б'], [[null, undefined]]);
    check('пустые значения дают пустые ячейки, а не «null»',
      empties === '\ufeffА;Б\r\n;\r\n', JSON.stringify(empties));

    // И сама выгрузка: она обязана видеть ровно то же, что список.
    await loginAs(db, anna);
    const exported = await (await exportContacts(
      new Request('https://liberterra.kg/cabinet/contacts/export'),
    )).text();
    check('в выгрузке есть свой контакт', exported.includes('Пётр Петров'));
    check('а чужого в выгрузке нет', !exported.includes('Клиент Бориса'));

    resetCookies();
    const refused = await exportContacts(
      new Request('https://liberterra.kg/cabinet/contacts/export'),
    );
    check('без входа выгрузка отказывает, а не падает пятисотой',
      refused.status === 403, `статус ${refused.status}`);

    // Следующий блок рассчитывает на вход Бориса — возвращаем как было.
    await loginAs(db, boris);

    // -----------------------------------------------------------------
    // Передача записи вместе с доступом к телефону
    // -----------------------------------------------------------------
    check('до передачи чужой телефон не виден',
      (await contactPhones(hers.id)).length === 0);

    await loginAs(db, anna);
    await transferContact(hers.id, boris);
    check('после передачи прежний владелец телефон не видит',
      (await contactPhones(hers.id)).length === 0);

    await loginAs(db, boris);
    check('после передачи новый владелец телефон видит',
      (await contactPhones(hers.id)).length === 1);

    // -----------------------------------------------------------------
    // Доли собственности: сумма не выходит за единицу
    // -----------------------------------------------------------------
    await loginAs(db, anna);
    const shared = await createObject({
      kind: 'house', deal_type: 'sale', address: 'Ала-Тоо 7', price_minor: 10_000_000,
    });
    const second = await createContact({ name: 'Второй собственник', phone: '0555 99 88 77' });
    await setObjectOwnership(shared.id, ivan.id, 'owner', 0.6);
    await throws('сумма долей за единицу не выходит',
      () => setObjectOwnership(shared.id, second.id, 'co_owner', 0.6), Conflict);
    await setObjectOwnership(shared.id, second.id, 'co_owner', 0.4);
    check('сумма ровно в единицу принимается', true);

    await removeObjectOwnership(shared.id, ivan.id, 'owner');
    const left = await db.prepare(
      'select count(*) as n from object_ownerships where object_id = ?',
    ).bind(shared.id).first<{ n: number }>();
    check('связь собственности снимается, когда сделки нет', (left?.n ?? 0) === 1,
      `осталось связей: ${left?.n}`);

    // -----------------------------------------------------------------
    // Инварианты 2 и 3: сделка только из подбора, комиссия не захватывается
    // -----------------------------------------------------------------
    await loginAs(db, anna);
    const forSale = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Токтогула 15',
      price_minor: 40_000_000, owner_name: 'Хозяин', owner_phone: '0700 55 44 33',
    });
    const saleMandate = await createMandate({ object_id: forSale.id, kind: 'exclusive' });
    await publishObject(forSale.id);

    // Потребность ведёт Борис: по инварианту 3 доля closing достаётся ему,
    // кто бы подбор ни создал.
    await loginAs(db, boris);
    const need = await createRequirement({
      deal_type: 'sale', client_name: 'Покупатель', client_phone: '0701 10 10 10',
      budget_max_minor: 45_000_000,
    });

    await loginAs(db, anna);
    const match = await createMatch(forSale.id, need.id);
    check('инв.3: closing-агент берётся из потребности, а не из того, кто нажал',
      match.closing_agent_id === boris,
      `вышло ${match.closing_agent_id === anna ? 'Анна' : match.closing_agent_id}`);

    await throws('инв.2: «в сделке» руками не ставится',
      () => setMatchStatus(match.id, 'in_deal'), Conflict);

    const deal = await createDealFromMatch(match.id);
    check('инв.2: сделка заводится из подбора', deal.match_id === match.id);
    check('инв.2: объект и потребность взяты из подбора',
      deal.object_id === forSale.id && deal.requirement_id === need.id);
    check('инв.3: listing-агент взят из мандата',
      deal.listing_agent_id === saleMandate.listing_agent_id);
    check('инв.3: closing-агент взят из подбора',
      deal.closing_agent_id === boris);

    const matchNow = await db.prepare('select status from matches where id = ?')
      .bind(match.id).first<{ status: string }>();
    check('инв.2: подбор перешёл в сделку', matchNow?.status === 'in_deal');

    // До закрытия суммы индикативны и в базе не лежат.
    const before = await indicativeCommission(deal.id);
    const storedBefore = await getDeal(deal.id);
    check('инв.3: до закрытия комиссия не зафиксирована',
      storedBefore?.commission_total_minor === null);
    check('инв.3: до закрытия комиссия считается от цены объекта',
      before.total === 800_000, `вышло ${before.total}`);

    await setDealStatus(deal.id, 'documents');

    // Посторонний закрыть сделку не может.
    const vera = await seedAgent(db, 'vera');
    await loginAs(db, vera);
    await throws('закрыть сделку может только её сторона',
      () => closeDeal(deal.id, 38_000_000), Forbidden);

    await loginAs(db, anna);
    const closed = await closeDeal(deal.id, 38_000_001);
    check('инв.3: комиссия считается от финальной цены',
      closed.commission_total_minor === 760_000, `вышло ${closed.commission_total_minor}`);
    check('инв.3: доли складываются ровно в итог',
      (closed.listing_share_minor ?? 0) + (closed.closing_share_minor ?? 0)
        === closed.commission_total_minor);

    const mandateAfter = await db.prepare('select status from mandates where id = ?')
      .bind(saleMandate.id).first<{ status: string }>();
    const needAfter = await db.prepare('select status from requirements where id = ?')
      .bind(need.id).first<{ status: string }>();
    check('инв.2: закрытие закрывает мандат',
      mandateAfter?.status === 'closed_by_deal', `статус ${mandateAfter?.status}`);
    check('инв.2: закрытие закрывает потребность',
      needAfter?.status === 'closed', `статус ${needAfter?.status}`);

    await throws('закрытую сделку второй раз не закрыть',
      () => closeDeal(deal.id, 1), Conflict);

    // Срыв: мандат и потребность НЕ закрываются, работа продолжается.
    const obj2 = await createObject({
      kind: 'flat', deal_type: 'rent', address: 'Жибек Жолу 3', price_minor: 3_000_000,
    });
    await createMandate({ object_id: obj2.id, kind: 'non_exclusive' });
    const need2 = await createRequirement({ deal_type: 'rent', client_name: 'Арендатор' });
    const match2 = await createMatch(obj2.id, need2.id);
    const deal2 = await createDealFromMatch(match2.id);
    const failed = await failDeal(deal2.id, 'клиент передумал');
    const need2After = await db.prepare('select status from requirements where id = ?')
      .bind(need2.id).first<{ status: string }>();

    check('срыв не закрывает потребность', need2After?.status === 'qualified',
      `статус ${need2After?.status}`);
    check('срыв требует причины', failed.failure_reason === 'клиент передумал');

    // -----------------------------------------------------------------
    // Напоминания: очередь идемпотентна
    // -----------------------------------------------------------------
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const task = await createActivity({
      kind: 'task', entity_type: 'object', entity_id: forSale.id,
      body: 'позвонить собственнику', due_at: soon,
    });

    const firstRun = await enqueueDueReminders();
    const secondRun = await enqueueDueReminders();
    const queued = await db.prepare(
      'select count(*) as n from notifications where activity_id = ?',
    ).bind(task.id).first<{ n: number }>();

    check('напоминание ставится в очередь', firstRun >= 1, `поставлено ${firstRun}`);
    check('повторный прогон расписания не плодит дублей',
      (queued?.n ?? 0) === 1, `записей по задаче: ${queued?.n}`);
    check('второй прогон не добавил ничего', secondRun === 0, `добавлено ${secondRun}`);

    // Агент без Telegram получает запись «нечем доставить», а не тишину.
    const noChannel = await db.prepare(
      `select status from notifications where activity_id = ?`,
    ).bind(task.id).first<{ status: string }>();
    check('без привязанного Telegram статус «нечем доставить»',
      noChannel?.status === 'no_channel', `статус ${noChannel?.status}`);

    // Выполненная задача гасит своё напоминание.
    await db.prepare(`update notifications set status = 'pending' where activity_id = ?`)
      .bind(task.id).run();
    await setActivityDone(task.id, true);
    const cancelled = await db.prepare(
      'select status from notifications where activity_id = ?',
    ).bind(task.id).first<{ status: string }>();
    check('выполненная задача гасит напоминание',
      cancelled?.status === 'cancelled', `статус ${cancelled?.status}`);

    // Выдача на отправку не отдаёт одно и то же дважды.
    await db.prepare(`update notifications set status = 'pending', attempts = 0
                       where activity_id = ?`).bind(task.id).run();
    const batch1 = await claimNotifications();
    const batch2 = await claimNotifications();
    check('взятое на отправку второй раз не выдаётся',
      batch1.length === 1 && batch2.length === 0,
      `первая партия ${batch1.length}, вторая ${batch2.length}`);

    await markNotification(batch1[0].id, false, 'канал недоступен');
    const retried = await db.prepare(
      'select status, attempts from notifications where activity_id = ?',
    ).bind(task.id).first<{ status: string; attempts: number }>();
    check('неудача возвращает в очередь и считает попытку',
      retried?.status === 'pending' && retried?.attempts === 1,
      `статус ${retried?.status}, попыток ${retried?.attempts}`);

    // -----------------------------------------------------------------
    // Заявки с сайта: единственная запись от неизвестного
    // -----------------------------------------------------------------
    await loginAs(db, anna);
    const forLeads = await createObject({
      kind: 'flat', deal_type: 'rent', address: 'Манаса 40', price_minor: 2_500_000,
    });
    await createMandate({ object_id: forLeads.id, kind: 'non_exclusive' });
    await publishObject(forLeads.id);

    const draft = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Черновик 1', price_minor: 1_000_000,
    });

    const leadId = await submitLead({
      object_id: forLeads.id, name: 'Азамат', phone: '0555 00 11 22',
      message: 'когда можно посмотреть?',
    });
    check('заявка принимается по опубликованному объекту', Boolean(leadId));

    await throws('по черновику заявка не принимается',
      () => submitLead({ object_id: draft.id, name: 'Х', phone: '0555 00 11 23' }),
      NotFound);
    await throws('по несуществующему объекту — тот же ответ, что по черновику',
      () => submitLead({ object_id: crypto.randomUUID(), name: 'Х', phone: '0555 00 11 24' }),
      NotFound);

    // Повтор той же пары за сутки отдаёт прежнюю заявку: человек нажал
    // дважды, агент не должен звонить дважды.
    const again2 = await submitLead({
      object_id: forLeads.id, name: 'Азамат', phone: '+996555001122',
    });
    check('повтор за сутки возвращает прежнюю заявку', again2 === leadId);

    // Приманка: отвечаем как при успехе, но в базу ничего не идёт.
    const leadsBefore = await db.prepare('select count(*) as n from leads').first<{ n: number }>();
    await submitLead({
      object_id: forLeads.id, name: 'Бот', phone: '0700 99 99 99', trap: 'я бот',
    });
    const leadsAfter = await db.prepare('select count(*) as n from leads').first<{ n: number }>();
    check('заполненная приманка не пишет в базу',
      leadsBefore?.n === leadsAfter?.n,
      `было ${leadsBefore?.n}, стало ${leadsAfter?.n}`);

    await throws('телефон не похож на номер — отказ',
      () => submitLead({ object_id: forLeads.id, name: 'Х', phone: '12' }), Invalid);
    await throws('пустое имя — отказ',
      () => submitLead({ object_id: forLeads.id, name: '  ', phone: '0555 77 88 99' }),
      Invalid);

    // По заявке заведена задача тому, кто ведёт объект.
    const leadRow = await db.prepare('select * from leads where id = ?')
      .bind(leadId).first<{ activity_id: string | null; status: string }>();
    check('по заявке заведена задача', leadRow?.activity_id !== null);

    const mine = await listLeads();
    check('агент видит заявки по своим объектам', mine.some((l) => l.id === leadId));

    await loginAs(db, vera);
    const hers2 = await listLeads();
    check('посторонний агент чужих заявок не видит',
      !hers2.some((l) => l.id === leadId));
    await throws('посторонний не ведёт чужую заявку',
      () => setLeadStatus(leadId, 'done'), Forbidden);

    await loginAs(db, anna);
    await setLeadStatus(leadId, 'done');
    const doneTask = await db.prepare('select done from activities where id = ?')
      .bind(leadRow?.activity_id ?? '').first<{ done: number }>();
    check('отработанная заявка закрывает свою задачу', doneTask?.done === 1);

    // -----------------------------------------------------------------
    // Агенты: повысить себя нельзя
    // -----------------------------------------------------------------
    const newcomer = await ensureAgentByEmail('novichok@example.kg', 'Новичок');
    check('новый агент рождается в ожидании', newcomer.status === 'pending');

    const again3 = await ensureAgentByEmail('novichok@example.kg');
    check('инв.6: повторный вход не плодит вторую запись', again3.id === newcomer.id);

    await throws('агент не может одобрить сам себя',
      () => approveAgent(newcomer.id), Forbidden);
    await throws('агент не может выдать себе админа',
      () => setAgentRole(anna, 'admin'), Forbidden);

    // Правка профиля трогает только имя и телефон. Проверяем не тем, что
    // честный вызов ничего лишнего не сломал, а тем, что НЕЧЕСТНЫЙ не
    // проходит: подсовываем роль и статус прямо в правку профиля — ровно
    // так эта дыра и выглядела на Postgres, где политика «правь свои
    // строки» означала «правь любую колонку своих строк».
    await updateProfile({
      full_name: 'Анна Петрова',
      phone: '0700 12 34 56',
      role: 'admin',
      status: 'approved',
      email: 'other@example.kg',
    } as unknown as { full_name: string });

    const annaRow = await getAgent(anna);
    check('правка профиля меняет имя', annaRow?.full_name === 'Анна Петрова');
    check('через правку профиля роль не выдаётся',
      annaRow?.role === 'agent', `роль стала ${annaRow?.role}`);
    check('через правку профиля статус не меняется',
      annaRow?.status === 'approved', `статус стал ${annaRow?.status}`);
    check('через правку профиля почта не подменяется',
      annaRow?.email === 'anna@example.kg', `почта стала ${annaRow?.email}`);

    // -----------------------------------------------------------------
    // Ожидающий одобрения правит свою карточку
    // -----------------------------------------------------------------
    // Это не послабление, а починка. Страница ожидания показывает форму
    // профиля и прямо зовёт заполнить её, не дожидаясь одобрения: админ
    // видит в списке заявок одну строку и по почте не поймёт, кто её
    // подал. Но форма звала requireAgent и потому не работала НИКОГДА —
    // ожидающий получал «Требуется одобренный агент».
    //
    // Нашлось живым входом с настоящей почты: ни один тест сюда не
    // заглядывал.
    await loginAs(db, newcomer.id);

    await updateProfile({ full_name: 'Пётр Новичков', phone: '0555 11 22 33' });
    const pendingRow = await getAgent(newcomer.id);
    check('ожидающий вписывает своё имя',
      pendingRow?.full_name === 'Пётр Новичков');
    check('ожидающий остаётся ожидающим',
      pendingRow?.status === 'pending', `статус стал ${pendingRow?.status}`);

    // Мессенджеры — со слов агента, и записываются ровно так, как
    // сказано: проверить номер в WhatsApp или Telegram нельзя.
    await updateProfile({ whatsapp: true, telegram_user: '@petr_novich' });
    const withMess = await getAgent(newcomer.id);
    check('WhatsApp отмечается', withMess?.whatsapp === 1);
    check('ник Telegram чистится от «@» и ссылки',
      withMess?.telegram_user === 'petr_novich');

    await updateProfile({ telegram_user: 'https://t.me/petr_novich' });
    check('адрес целиком тоже приводится к нику',
      (await getAgent(newcomer.id))?.telegram_user === 'petr_novich');

    await throws('ник с пробелом и кириллицей не проходит',
      () => updateProfile({ telegram_user: 'Пётр Новичков' }), Invalid);

    await updateProfile({ telegram_user: '' });
    check('пустой ник снимает кнопку Telegram',
      (await getAgent(newcomer.id))?.telegram_user === null);

    await setMyOrganization('Этажи');
    check('ожидающий заявляет агентство',
      (await getAgent(newcomer.id))?.org_confirmed === 0);

    // Послабление РОВНО на свою карточку: в саму CRM ожидающего не пускают.
    await throws('ожидающему CRM по-прежнему закрыта',
      () => objectList({}), Forbidden);

    // Заблокированному закрыта и своя карточка: доступ отозван целиком.
    await db.prepare(`update agents set status = 'blocked' where id = ?`)
      .bind(newcomer.id).run();
    await throws('заблокированный свою карточку не правит',
      () => updateProfile({ full_name: 'Кто-то ещё' }), Forbidden);
    await db.prepare(`update agents set status = 'pending' where id = ?`)
      .bind(newcomer.id).run();

    // Без входа — никакой карточки. Проверка отдельная, потому что
    // мутация «requireSelf пускает всех подряд» её не роняла: ни один
    // тест не пробовал править профиль анонимно, и ошибка прошла бы в
    // продакшен обращением к пустому агенту.
    resetCookies();
    await throws('без входа своя карточка не правится',
      () => updateProfile({ full_name: 'Никто' }), Forbidden);

    await loginAs(db, anna);

    // Админ может всё это, и последнего админа не разжаловать.
    await db.prepare(`update agents set role = 'admin' where id = ?`).bind(anna).run();
    await loginAs(db, anna);
    const approved = await approveAgent(newcomer.id);
    check('админ одобряет агента', approved.status === 'approved');

    await throws('последнего админа не разжаловать',
      () => setAgentRole(anna, 'agent'), Conflict);
    await throws('последнего админа не заблокировать',
      () => blockAgent(anna), Conflict);

    // Блокировка выбрасывает чужие сессии.
    await blockAgent(boris);
    const borisSessions = await db.prepare(
      'select count(*) as n from sessions where agent_id = ?',
    ).bind(boris).first<{ n: number }>();
    check('блокировка снимает сессии агента', (borisSessions?.n ?? 0) === 0);

    // -----------------------------------------------------------------
    // Агентство: агент заявляет, админ подтверждает
    // -----------------------------------------------------------------
    await loginAs(db, vera);
    const claimed = await setMyOrganization('Этажи');
    check('агент заявляет агентство', claimed.organization_id !== null);
    check('заявленное агентство не подтверждено', claimed.org_confirmed === 0);

    await throws('подтвердить своё агентство агент не может',
      () => confirmAgentOrganization(vera, true), Forbidden);

    // Название уникально по нормализованному виду.
    await loginAs(db, anna);
    await setMyOrganization('ЭТАЖИ  ');
    const annaOrg = await getAgent(anna);
    check('«Этажи» и «ЭТАЖИ» — одно агентство',
      annaOrg?.organization_id === claimed.organization_id);

    const orgCount = await db.prepare('select count(*) as n from organizations')
      .first<{ n: number }>();
    check('второго агентства с тем же названием не завелось',
      (orgCount?.n ?? 0) === 1, `агентств: ${orgCount?.n}`);

    const confirmed2 = await confirmAgentOrganization(vera, true);
    check('админ подтверждает агентство', confirmed2.org_confirmed === 1);

    await loginAs(db, vera);
    const quit = await clearMyOrganization();
    check('уйти из агентства агент может сам',
      quit.organization_id === null && quit.org_confirmed === 0);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Вход по ссылке на почту
    // -----------------------------------------------------------------
    resetCookies();
    outbox.length = 0;

    await requestLogin({
      email: ' Novichok@Example.KG ', origin: 'https://liberterra.kg',
      redirect_to: '/cabinet/objects',
    });
    check('письмо со ссылкой отправлено', outbox.length === 1);
    check('адрес приведён к нижнему регистру и обрезан',
      outbox[0]?.to === 'novichok@example.kg', `ушло на ${outbox[0]?.to}`);

    const linkToken = tokenFromLastLetter();
    check('в письме есть токен', Boolean(linkToken));

    // В базе лежит ХЭШ, а не сам токен: утечка таблицы не даёт войти.
    const stored = await db.prepare('select token_hash from login_tokens where email = ?')
      .bind('novichok@example.kg').first<{ token_hash: string }>();
    check('в базе лежит не сам токен, а его хэш',
      Boolean(stored) && stored?.token_hash !== linkToken);

    const entered = await completeLogin(linkToken ?? '');
    check('вход по ссылке заводит сессию', entered.agent.email === 'novichok@example.kg');
    check('возврат идёт на запрошенную страницу',
      entered.redirect_to === '/cabinet/objects');

    const who = await sessionAgent();
    check('после входа сессия видна', who?.id === entered.agent.id);

    await throws('ссылка срабатывает ровно один раз',
      () => completeLogin(linkToken ?? ''), Forbidden);
    await throws('выдуманная ссылка не пускает',
      () => completeLogin('deadbeef'), Forbidden);

    // Истёкшая ссылка отвечает так же, как использованная.
    await requestLogin({ email: 'novichok@example.kg', origin: 'https://liberterra.kg' });
    const expiring = tokenFromLastLetter();
    await db.prepare('update login_tokens set expires_at = ? where used_at is null')
      .bind('2000-01-01T00:00:00.000Z').run();
    await throws('протухшая ссылка не пускает',
      () => completeLogin(expiring ?? ''), Forbidden);

    // Открытое перенаправление: ссылка из письма не уводит на чужой сайт.
    await requestLogin({
      email: 'novichok@example.kg', origin: 'https://liberterra.kg',
      redirect_to: '//evil.example.com/hack',
    });
    const safeToken = tokenFromLastLetter();
    const safeEntry = await completeLogin(safeToken ?? '');
    check('ссылка не уводит на чужой сайт',
      safeEntry.redirect_to === '/cabinet', `повела на ${safeEntry.redirect_to}`);

    // Непроверенный агент в кабинет не попадает, хотя сессия у него есть.
    await db.prepare(`update agents set status = 'pending' where email = ?`)
      .bind('novichok@example.kg').run();
    check('сессия есть и у неодобренного', (await sessionAgent()) !== null);
    check('но кабинет ему закрыт', (await currentAgent()) === null);

    // Заблокированного не пускают вовсе.
    await db.prepare(`update agents set status = 'blocked' where email = ?`)
      .bind('novichok@example.kg').run();
    await requestLogin({ email: 'novichok@example.kg', origin: 'https://liberterra.kg' });
    await throws('заблокированного не пускают',
      () => completeLogin(tokenFromLastLetter() ?? ''), Forbidden);

    // Частота: перебор и заваливание чужого ящика.
    outbox.length = 0;
    await db.prepare('delete from login_tokens').run();
    for (let i = 0; i < 5; i++) {
      await requestLogin({ email: 'flood@example.kg', origin: 'https://liberterra.kg' });
    }
    await throws('шестая попытка входа за час отклонена',
      () => requestLogin({ email: 'flood@example.kg', origin: 'https://liberterra.kg' }),
      Invalid);
    check('писем ушло ровно пять', outbox.length === 5, `ушло ${outbox.length}`);

    await throws('это не похоже на почту — отказ',
      () => requestLogin({ email: 'не почта', origin: 'https://liberterra.kg' }), Invalid);

    // Выход снимает сессию и в браузере, и в базе.
    await db.prepare(`update agents set status = 'approved' where email = ?`)
      .bind('novichok@example.kg').run();
    await requestLogin({ email: 'novichok@example.kg', origin: 'https://liberterra.kg' });
    const last = await completeLogin(tokenFromLastLetter() ?? '');
    const before2 = await db.prepare('select count(*) as n from sessions where agent_id = ?')
      .bind(last.agent.id).first<{ n: number }>();
    await endSession();
    const after2 = await db.prepare('select count(*) as n from sessions where agent_id = ?')
      .bind(last.agent.id).first<{ n: number }>();
    // Выход снимает ровно ОДНУ сессию — ту, из которой вышли. Выходить на
    // одном устройстве и терять вход на остальных человек не ожидает, а
    // «выйти везде» — отдельное действие, и его здесь нет.
    check('выход снимает ровно одну сессию',
      (before2?.n ?? 0) - (after2?.n ?? 0) === 1,
      `было ${before2?.n}, стало ${after2?.n}`);
    check('прочие сессии агента остались', (after2?.n ?? 0) > 0);
    check('после выхода агента нет', (await sessionAgent()) === null);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Приглашение агента ссылкой: письмо на бесплатном плане не дойдёт
    // -----------------------------------------------------------------
    outbox.length = 0;

    const invite = await inviteAgent({
      email: '  Nurlan@Example.KG ', full_name: 'Нурлан Орозов',
      origin: 'https://liberterra.kg/',
    });

    check('адрес приведён к нижнему регистру и обрезан',
      invite.email === 'nurlan@example.kg', `получилось ${invite.email}`);
    check('это новый человек, а не повторная выдача', invite.existed === false);
    check('имя записано сразу, а не почта вместо имени',
      invite.full_name === 'Нурлан Орозов', invite.full_name);

    // Письма тут нет и не должно быть: весь смысл в том, что доставку
    // берёт на себя админ. Если письмо вдруг уйдёт — значит кто-то вернул
    // отправку, и приглашение станет бессмысленным.
    check('письма не отправлялось', outbox.length === 0, `ушло ${outbox.length}`);

    check('ссылка абсолютная и без двойного слэша',
      invite.link.startsWith('https://liberterra.kg/auth/enter?token='),
      invite.link.replace(/token=.*/, 'token=…'));

    const inviteToken = invite.link.split('token=')[1] ?? '';
    const inviteStored = await db
      .prepare('select token_hash, issued_by_agent_id from login_tokens where email = ?')
      .bind('nurlan@example.kg')
      .first<{ token_hash: string; issued_by_agent_id: string | null }>();
    check('в базе лежит не сама ссылка, а хэш токена',
      Boolean(inviteStored) && inviteStored?.token_hash !== inviteToken);
    check('в базе записано, кто выдал', inviteStored?.issued_by_agent_id === anna);

    const inviteAudit = await db
      .prepare(`select actor_agent_id from audit_log
                 where entity_type = 'agent_invite' order by id desc limit 1`)
      .first<{ actor_agent_id: string | null }>();
    check('выдача записана в журнал с именем выдавшего',
      inviteAudit?.actor_agent_id === anna);

    // Приглашённый уже числится агентом, со статусом «ожидает»: админ
    // видит его в списке и может одобрить ДО того, как тот войдёт.
    const invited = await db.prepare('select id, status from agents where email = ?')
      .bind('nurlan@example.kg').first<{ id: string; status: string }>();
    check('учётная запись заведена сразу', Boolean(invited));
    check('и она ждёт одобрения', invited?.status === 'pending');

    // Срок суточный, а не как у обычного входа: ссылку пересылают.
    const inviteTtl = await db
      .prepare(`select created_at, expires_at from login_tokens
                 where email = ? order by created_at desc limit 1`)
      .bind('nurlan@example.kg').first<{ created_at: string; expires_at: string }>();
    const inviteHours = inviteTtl
      ? (Date.parse(inviteTtl.expires_at) - Date.parse(inviteTtl.created_at)) / 3_600_000
      : 0;
    // Округление, а не точное равенство: created_at и expires_at ставятся
    // на соседних миллисекундах, и разница выходит 24.0000003 — проверка
    // на === проходила случайно и однажды упала бы без причины.
    check('ссылка живёт сутки, а не пятнадцать минут',
      Math.round(inviteHours) === 24, `получилось ${inviteHours} ч`);

    // Самое важное: по ссылке действительно входят, и ровно один раз.
    resetCookies();
    const byInvite = await completeLogin(inviteToken);
    check('по приглашению входят', byInvite.agent.email === 'nurlan@example.kg');
    await throws('и только один раз', () => completeLogin(inviteToken), Forbidden);

    await loginAs(db, anna);
    const reinvite = await inviteAgent({
      email: 'nurlan@example.kg', origin: 'https://liberterra.kg',
    });
    check('повторная выдача видит, что человек уже есть', reinvite.existed === true);
    check('и имя не затирается пустым',
      (await db.prepare('select full_name from agents where email = ?')
        .bind('nurlan@example.kg').first<{ full_name: string }>())?.full_name
        === 'Нурлан Орозов');

    // Заблокированному отказ — здесь, а не на входе: иначе админ отправит
    // ссылку, а человек увидит «доступ закрыт» и решит, что его только что
    // отключили.
    await db.prepare(`update agents set status = 'blocked' where email = ?`)
      .bind('nurlan@example.kg').run();
    await throws('заблокированному ссылку не выдают',
      () => inviteAgent({
        email: 'nurlan@example.kg', full_name: 'Переименованный',
        origin: 'https://liberterra.kg',
      }),
      Forbidden);
    // Отказ не должен оставлять следа. Заведение агента заодно обновляет
    // имя, и если проверять блокировку ПОСЛЕ него, отклонённое приглашение
    // всё равно переименовывало бы человека.
    check('и отказ не переименовал его по пути',
      (await db.prepare('select full_name from agents where email = ?')
        .bind('nurlan@example.kg').first<{ full_name: string }>())?.full_name
        === 'Нурлан Орозов');
    check('и лишней ссылки в базе не осталось',
      ((await db.prepare(`select count(*) as n from login_tokens
                           where email = ? and used_at is null`)
        .bind('nurlan@example.kg').first<{ n: number }>())?.n ?? -1) === 1);
    await db.prepare(`update agents set status = 'approved' where email = ?`)
      .bind('nurlan@example.kg').run();

    await throws('это не похоже на почту — отказ',
      () => inviteAgent({ email: 'не почта', origin: 'https://liberterra.kg' }), Invalid);

    // Выдаёт ТОЛЬКО админ: ссылка даёт вход в чужую учётную запись.
    await loginAs(db, vera);
    await throws('обычный агент приглашений не выдаёт',
      () => inviteAgent({ email: 'kto@example.kg', origin: 'https://liberterra.kg' }),
      Forbidden);
    resetCookies();
    await throws('и анонимно тоже',
      () => inviteAgent({ email: 'kto@example.kg', origin: 'https://liberterra.kg' }),
      Forbidden);

    // Приглашения НЕ съедают часовой предел самостоятельного входа.
    // Иначе пять выдач подряд закрывали бы агенту вход на час, то есть
    // предел бил бы по тому, кого защищает.
    await loginAs(db, anna);
    await db.prepare('delete from login_tokens').run();
    for (let i = 0; i < 6; i++) {
      await inviteAgent({ email: 'mnogo@example.kg', origin: 'https://liberterra.kg' });
    }
    outbox.length = 0;
    // Через try, а не напрямую: если предел снова начнёт считать выдачи,
    // requestLogin бросит исключение и оборвёт весь прогон раньше этой
    // проверки — красный прогон был бы, но сказал бы «что-то упало», а не
    // «приглашения съедают предел входа».
    let floodedByInvites: string | null = null;
    try {
      await requestLogin({ email: 'mnogo@example.kg', origin: 'https://liberterra.kg' });
    } catch (e) {
      floodedByInvites = e instanceof Error ? e.message : String(e);
    }
    check('после шести приглашений агент всё равно войдёт сам',
      floodedByInvites === null && outbox.length === 1,
      floodedByInvites ?? `писем ушло ${outbox.length}`);

    // А собственный предел при этом остался на месте: иначе проверка выше
    // прошла бы и на сломанном счётчике.
    await db.prepare('delete from login_tokens').run();
    for (let i = 0; i < 5; i++) {
      await requestLogin({ email: 'mnogo@example.kg', origin: 'https://liberterra.kg' });
    }
    await throws('а шестая попытка входа за час по-прежнему отклонена',
      () => requestLogin({ email: 'mnogo@example.kg', origin: 'https://liberterra.kg' }),
      Invalid);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Задачу можно поставить коллеге и передать коллеге
    // -----------------------------------------------------------------
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const colleagues = await approvedColleagues();
    check('список коллег отдаёт одобренных', colleagues.some((c) => c.id === vera));
    check('и не предлагает передать самому себе',
      !colleagues.some((c) => c.id === anna));

    // Маленькие списки сортируются в коде, через localeCompare. Имена
    // подменяются на ту же расходящуюся пару и возвращаются обратно:
    // настоящие имена агентов нужны другим проверкам.
    await loginAs(db, anna);
    const originals = await db.prepare(
      `select id, full_name from agents where id in (?, ?)`,
    ).bind(vera, newcomer.id).all<{ id: string; full_name: string }>();

    await db.prepare('update agents set full_name = ? where id = ?')
      .bind('Ядрин Коллега', vera).run();
    await db.prepare('update agents set full_name = ? where id = ?')
      .bind('абаев Коллега', newcomer.id).run();

    const names = (await approvedColleagues()).map((c) => c.full_name);
    check('в списке коллег строчный «абаев» идёт раньше заглавного «Ядрина»',
      names.indexOf('абаев Коллега') >= 0 && names.indexOf('Ядрин Коллега') >= 0
      && names.indexOf('абаев Коллега') < names.indexOf('Ядрин Коллега'),
      names.join(' | '));

    // Сопоставимое имя агента пишется в ТРЁХ местах, и на каждое своя
    // проверка: иначе одно из трёх однажды отстанет, и список будет
    // сортироваться по прежнему имени, а показывать новое.
    const sortOf = async (id: string) => (await db
      .prepare('select full_name, name_sort from agents where id = ?')
      .bind(id).first<{ full_name: string; name_sort: string }>());

    // Путь 1: заведение агента.
    const freshAgent = await ensureAgentByEmail('sortirovka@example.kg', 'ЯДРИН Сорт');
    check('у нового агента сопоставимое имя заполнено',
      (await sortOf(freshAgent.id))?.name_sort === 'ядрин сорт',
      String((await sortOf(freshAgent.id))?.name_sort));

    // Путь 1б: строка, заведённая ДО появления колонки. Такие в базе
    // есть — колонка пришла с пустым значением по умолчанию, и пустое
    // сортируется первым. Чинится при следующем входе, без переноса
    // данных и без ручной правки боевой базы.
    await db.prepare(`update agents set name_sort = '' where id = ?`)
      .bind(freshAgent.id).run();
    await ensureAgentByEmail('sortirovka@example.kg', 'ЯДРИН Сорт');
    check('пустое сопоставимое имя починилось при входе',
      (await sortOf(freshAgent.id))?.name_sort === 'ядрин сорт',
      String((await sortOf(freshAgent.id))?.name_sort));
    check('а само имя при этом не тронуто',
      (await sortOf(freshAgent.id))?.full_name === 'ЯДРИН Сорт');

    // Путь 2: переименование при входе.
    await ensureAgentByEmail('sortirovka@example.kg', 'АБАЕВ Сорт');
    check('и после переименования при входе — тоже',
      (await sortOf(freshAgent.id))?.name_sort === 'абаев сорт',
      String((await sortOf(freshAgent.id))?.name_sort));

    // Путь 3: правка профиля самим агентом.
    await db.prepare(`update agents set status = 'approved' where id = ?`)
      .bind(freshAgent.id).run();
    await loginAs(db, freshAgent.id);
    await updateProfile({ full_name: 'ВОРОНОВ Сорт' });
    check('и после правки профиля — тоже',
      (await sortOf(freshAgent.id))?.name_sort === 'воронов сорт',
      String((await sortOf(freshAgent.id))?.name_sort));

    // А теперь сам порядок: строчный агент не должен уезжать в конец.
    // Переименовываются ТЕ, КТО ведёт потребности в списке, — Анна и
    // Борис. Переименование кого-то другого проверку не затронуло бы, и
    // она проходила бы на пустой выдаче: так и случилось в первой версии.
    await loginAs(db, anna);
    const leading = await db.prepare(
      'select id, full_name, name_sort from agents where id in (?, ?)',
    ).bind(anna, boris).all<{ id: string; full_name: string; name_sort: string }>();

    // Пара снова выбрана так, чтобы побайтный порядок РАСХОДИЛСЯ с
    // алфавитным: строчная «а» это U+0430, заглавная «Я» — U+042F. Пара
    // «Абаев»/«ядрин» для этого не годится, там порядки совпадают — на
    // ней мутация «сортировать по ag.full_name» прошла молча.
    await db.prepare('update agents set full_name = ?, name_sort = ? where id = ?')
      .bind('абаев Ведущий', 'абаев ведущий', anna).run();
    await db.prepare('update agents set full_name = ?, name_sort = ? where id = ?')
      .bind('Ядрин Ведущий', 'ядрин ведущий', boris).run();

    const byAgent = (await requirementList({ sort: 'agent', dir: 'asc' }))
      .rows.map((r) => r.agent_name);
    const abaev = byAgent.indexOf('абаев Ведущий');
    const yadrin = byAgent.indexOf('Ядрин Ведущий');
    // Строго: без требования, чтобы ОБА были в списке, проверка проходила
    // бы и на пустой выдаче — то есть не проверяла бы ничего.
    check('оба ведущих есть в списке — значит проверка не пустая',
      abaev >= 0 && yadrin >= 0, `порядок: ${byAgent.join(' | ')}`);
    check('и строчный «абаев» идёт раньше заглавного «Ядрина»',
      abaev >= 0 && yadrin >= 0 && abaev < yadrin,
      `порядок: ${byAgent.join(' | ')}`);

    // То же для списка объектов: там колонка «ведёт» это отдельный
    // подзапрос, и свой порядок у него тоже свой — без проверки мутация
    // «сортировать по responsible_name» проходила бы молча.
    //
    // Объект Бориса нужен именно здесь: до этого места все объекты ведёт
    // Анна, и список был из одного имени — проверка проходила бы на
    // пустом сравнении.
    // Статус Бориса к этому месту уже менялся предыдущими блоками, и
    // неодобренный агент объект не заведёт. Возвращаем как было сразу
    // после — иначе сломается то, что идёт дальше.
    const borisStatus = await db.prepare('select status from agents where id = ?')
      .bind(boris).first<{ status: string }>();
    await db.prepare(`update agents set status = 'approved' where id = ?`)
      .bind(boris).run();

    await loginAs(db, boris);
    const borisObject = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Сортировочная 1',
      price_minor: 3_300_000,
    });
    await createMandate({ object_id: borisObject.id, kind: 'non_exclusive' });

    await db.prepare('update agents set status = ? where id = ?')
      .bind(borisStatus?.status ?? 'approved', boris).run();
    await loginAs(db, anna);

    const byLeader = (await objectList({ sort: 'agent', dir: 'asc' }))
      .rows.map((o) => o.responsible_name);
    const abaevObj = byLeader.indexOf('абаев Ведущий');
    const yadrinObj = byLeader.indexOf('Ядрин Ведущий');
    check('оба ведущих есть в списке объектов — проверка не пустая',
      abaevObj >= 0 && yadrinObj >= 0, `порядок: ${byLeader.join(' | ')}`);
    check('и в объектах строчный «абаев» идёт раньше',
      abaevObj >= 0 && yadrinObj >= 0 && abaevObj < yadrinObj,
      `порядок: ${byLeader.join(' | ')}`);

    for (const row of [...originals.results, ...leading.results]) {
      await db.prepare('update agents set full_name = ?, name_sort = ? where id = ?')
        .bind(row.full_name, row.full_name.toLowerCase(), row.id).run();
    }

    // Имя и агентство — и больше ничего. Список видит любой агент, а
    // телефоны коллег в выпадающем списке не нужны никому.
    const colleagueKeys = Object.keys(colleagues[0] ?? {}).sort().join(',');
    check('и только имя, без почты и телефона',
      colleagueKeys === 'full_name,id', colleagueKeys);

    // Постановка на коллегу: агентство так и работает.
    const forVera = await createActivity({
      kind: 'task', entity_type: 'object', entity_id: forSale.id,
      body: 'показать квартиру вместо меня', due_at: nextWeek,
      agent_id: vera,
    });
    check('задачу можно поставить на коллегу', forVera.agent_id === vera);

    // Ради чего всё: задача должна появиться в списке дел ТОГО, на кого
    // поставлена, а не того, кто поставил. Иначе коллега о ней не узнает.
    await loginAs(db, vera);
    // Дела разложены по вкладкам (просрочено, со сроком, без срока), и
    // задача лежит в той, куда попал её срок. Проверяем по всем сразу:
    // важно, что она у коллеги есть, а не в какой она вкладке.
    const everyTask = async () => (await Promise.all(
      (['overdue', 'due', 'nodate'] as const).map((s) => myActivities(s)),
    )).flatMap((p) => p.rows);

    check('и она появилась в списке дел коллеги',
      (await everyTask()).some((t) => t.id === forVera.id));
    await loginAs(db, anna);
    check('а в моём списке её нет',
      !(await everyTask()).some((t) => t.id === forVera.id));

    const assignAudit = await db
      .prepare(`select diff from audit_log where entity_type = 'activities'
                 and entity_id = ? order by id desc limit 1`)
      .bind(forVera.id).first<{ diff: string }>();
    check('в журнале видно, что задачу выдал один, а делает другой',
      String(assignAudit?.diff ?? '').includes(vera));

    // Выдуманный и неодобренный — отказ. Проверка значения живёт в слое
    // доступа: до сих пор agent_id никто не проверял, потому что из
    // браузера он был недоступен.
    await throws('на выдуманного агента задачу не поставить',
      () => createActivity({
        kind: 'task', entity_type: 'object', entity_id: forSale.id,
        due_at: nextWeek, agent_id: 'нет-такого',
      }), NotFound);

    await db.prepare(`update agents set status = 'blocked' where id = ?`).bind(vera).run();
    await throws('на заблокированного — тоже отказ',
      () => createActivity({
        kind: 'task', entity_type: 'object', entity_id: forSale.id,
        due_at: nextWeek, agent_id: vera,
      }), Invalid);
    check('и заблокированного нет в списке коллег',
      !(await approvedColleagues()).some((c) => c.id === vera));
    await db.prepare(`update agents set status = 'approved' where id = ?`).bind(vera).run();

    // Передача: напоминание обязано уехать за задачей.
    const myTask = await createActivity({
      kind: 'task', entity_type: 'object', entity_id: forSale.id,
      body: 'съездить на замеры', due_at: nextWeek,
    });
    check('задача по умолчанию на себе', myTask.agent_id === anna);

    await db.prepare(
      `insert into notifications (id, agent_id, activity_id, kind, status, body, created_at)
       values (?, ?, ?, 'due_soon', 'pending', 'съездить на замеры', ?)`,
    ).bind('n-reassign', anna, myTask.id, new Date().toISOString()).run();

    const moved = await reassignActivity(myTask.id, vera);
    check('задача передана', moved.agent_id === vera);

    // Вот ради чего всё: напоминание хранит агента отдельной колонкой, и
    // без переписывания очереди «позвоните клиенту» ушло бы прежнему
    // владельцу по задаче, которой у него уже нет.
    const movedNote = await db.prepare('select agent_id from notifications where id = ?')
      .bind('n-reassign').first<{ agent_id: string }>();
    check('и напоминание уехало за ней',
      movedNote?.agent_id === vera, `осталось на ${movedNote?.agent_id}`);

    // Уже отправленное напоминание не переписывается: его агент — факт о
    // прошлом, и правка была бы подделкой истории.
    await db.prepare(
      `insert into notifications (id, agent_id, activity_id, kind, status, body, created_at, sent_at)
       values (?, ?, ?, 'overdue', 'sent', 'просрочено', ?, ?)`,
    ).bind('n-sent', vera, myTask.id, new Date().toISOString(), new Date().toISOString()).run();
    await loginAs(db, vera);
    await reassignActivity(myTask.id, anna);
    const sentNote = await db.prepare('select agent_id from notifications where id = ?')
      .bind('n-sent').first<{ agent_id: string }>();
    check('отправленное напоминание осталось на прежнем агенте',
      sentNote?.agent_id === vera, `стало ${sentNote?.agent_id}`);

    // Передавать может тот, на ком задача, или админ. Иначе чужую задачу
    // можно спихнуть любому: пришёл, нашёл запись, переписал владельца.
    await loginAs(db, vera);
    await throws('чужую задачу коллега не передаёт',
      () => reassignActivity(myTask.id, vera), Forbidden);

    await loginAs(db, anna);
    const noop = await reassignActivity(myTask.id, anna);
    check('передача себе же ничего не меняет', noop.agent_id === anna);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Публичный каталог: чего в витрине быть не должно
    // -----------------------------------------------------------------
    await loginAs(db, anna);
    const shown = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Чүй 200', zone: 'Центр',
      rooms: 3, area: 78, price_minor: 7_000_000,
      owner_name: 'Собственник витрины', owner_phone: '0555 12 13 14',
    });
    await createMandate({ object_id: shown.id, kind: 'non_exclusive' });
    await publishObject(shown.id);

    const hidden = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Тайная 1', price_minor: 1_000_000,
    });

    const page = await catalogPage({});
    const card = page.items.find((i) => i.id === shown.id);
    check('опубликованный объект в витрине есть', Boolean(card));
    check('черновика в витрине нет', !page.items.some((i) => i.id === hidden.id));

    // Состав выдачи. Это та самая проверка, которая на Postgres роняла
    // прогон при попытке добавить в витрину колонку «ведёт».
    const forbidden = [
      'created_by_agent_id', 'agent_id', 'listing_agent_id', 'closing_agent_id',
      'owner_agent_id', 'organization_id', 'commission_total_minor',
      'commission_rule', 'publication_state', 'contact_id', 'phone',
    ];
    const leaked = forbidden.filter((k) => card !== undefined && k in card);
    check('в витрине нет ни агента, ни комиссии, ни контактов',
      leaked.length === 0, `просочилось: ${leaked.join(', ')}`);

    const whole = await db.prepare('select * from objects where id = ?')
      .bind(shown.id).first<Record<string, unknown>>();
    check('а в самой таблице эти колонки есть — значит проверка не пустая',
      Boolean(whole) && 'created_by_agent_id' in (whole ?? {}));

    // Черновик по прямой ссылке — ничего, а не устаревшая цена.
    check('черновик по прямой ссылке не отдаётся',
      (await catalogObject(hidden.id)) === null);
    check('опубликованный по прямой ссылке отдаётся',
      (await catalogObject(shown.id))?.id === shown.id);

    // -----------------------------------------------------------------
    // Агент на публичной карточке
    // -----------------------------------------------------------------
    // Витрина годами не отдавала об агенте ничего. Теперь отдаёт четыре
    // поля — и ни одним больше. Проверяется прежде всего то, чего в
    // выдаче быть НЕ должно: утечка отсюда необратима, страницу видит
    // любой.

    await loginAs(db, anna);
    await updateProfile({ works_since: 2015, certificate_no: 'КР-777' });

    const shownAgent = await catalogAgent(shown.id);
    check('витрина называет агента, ведущего объект',
      shownAgent?.full_name === (await getAgent(anna))?.full_name);
    check('стаж отдаётся годом начала', shownAgent?.works_since === 2015);

    // Главное: непроверенный сертификат наружу не уходит вовсе.
    check('незаверенный сертификат витрина не отдаёт',
      shownAgent?.certificate_no === null,
      `просочилось: ${shownAgent?.certificate_no}`);

    await confirmAgentCertificate(anna, true);
    check('подтверждённый — отдаёт',
      (await catalogAgent(shown.id))?.certificate_no === 'КР-777');

    // Снял админ подтверждение — поле исчезает снова.
    await confirmAgentCertificate(anna, false);
    check('снятое подтверждение убирает номер из выдачи',
      (await catalogAgent(shown.id))?.certificate_no === null);

    // Состав выдачи. Та же проверка, что защищает объекты витрины, и по
    // той же причине: сюда легко дописать «ещё одно поле».
    const agentKeys = Object.keys((await catalogAgent(shown.id)) ?? {});
    // Из этого списка УБРАНЫ два поля, и каждое — решением владельца
    // площадки, а не упрощением. Идентификатор: он стоит в адресе
    // страницы агента, и прятать его здесь было бы непоследовательностью.
    // Телефон: покупатель пишет тому, кто ведёт объект, — прежний порядок
    // со звонком в отдел продаж этого не давал. Почта, статус и роль
    // закрыты как были: по почте в недвижимости не отвечают, а статус —
    // внутреннее дело.
    const forbiddenAgent = ['email', 'telegram_id', 'role',
      'status', 'organization_id', 'certificate_confirmed'];
    check('в выдаче агента нет ни почты, ни статуса, ни роли',
      forbiddenAgent.every((k) => !agentKeys.includes(k)),
      `просочилось: ${agentKeys.join(', ')}`);
    check('телефон агента теперь отдаётся — по нему и звонят из объявления',
      agentKeys.includes('phone') && agentKeys.includes('whatsapp')
      && agentKeys.includes('telegram_user'));
    check('а идентификатор отдаётся — на него ведёт ссылка со страницы объекта',
      (await catalogAgent(shown.id))?.id === anna);

    // А в самой таблице эти колонки есть — иначе проверка была бы пустой.
    const agentRow = await db.prepare('select * from agents where id = ?')
      .bind(anna).first<Record<string, unknown>>();
    check('а в таблице агентов эти колонки есть',
      Boolean(agentRow) && 'phone' in (agentRow ?? {}) && 'email' in (agentRow ?? {}));

    // -----------------------------------------------------------------
    // Публичная страница агента: только настоящее
    // -----------------------------------------------------------------
    await confirmAgentCertificate(anna, true);
    const listed = await catalogAgents();
    const me = listed.find((a) => a.id === anna);

    check('агент с опубликованным объектом есть в списке', Boolean(me));
    check('и у него считаются объекты', (me?.objects ?? 0) >= 1, `${me?.objects}`);
    check('подтверждённый номер в реестре отдаётся', me?.certificate_no === 'КР-777');

    // Состав выдачи — та же проверка, что у карточки объекта: сюда так же
    // легко дописать «ещё одно поле», и это так же необратимо.
    const cardKeys = Object.keys(me ?? {}).sort();
    check('в выдаче агента нет ни почты, ни статуса',
      !cardKeys.includes('email')
      && !cardKeys.includes('status') && !cardKeys.includes('certificate_confirmed'),
      cardKeys.join(', '));
    check('а телефон и мессенджеры есть — страница агента для того и нужна',
      cardKeys.includes('phone') && cardKeys.includes('whatsapp'));

    // Агентство — только подтверждённое. То же правило, что у сертификата:
    // принадлежность к фирме агент заявляет сам.
    await setMyOrganization('Этажи');
    check('незаверенное агентство наружу не уходит',
      (await catalogAgentById(anna))?.organization === null,
      String((await catalogAgentById(anna))?.organization));
    await confirmAgentOrganization(anna, true);
    check('подтверждённое — отдаётся',
      (await catalogAgentById(anna))?.organization === 'Этажи');

    // Неодобренного и заблокированного на сайте быть не должно.
    await db.prepare(`update agents set status = 'blocked' where id = ?`).bind(anna).run();
    check('заблокированного агента в списке нет',
      !(await catalogAgents()).some((a) => a.id === anna));
    check('и по прямой ссылке его нет', (await catalogAgentById(anna)) === null);
    await db.prepare(`update agents set status = 'approved' where id = ?`).bind(anna).run();

    // Агент без опубликованных объектов — не страница, а пустое обещание.
    const noObjects = await ensureAgentByEmail('bezobektov@example.kg', 'Безобъектов Агент');
    await db.prepare(`update agents set status = 'approved' where id = ?`)
      .bind(noObjects.id).run();
    check('агента без опубликованных объектов в списке нет',
      !(await catalogAgents()).some((a) => a.id === noObjects.id));
    check('и его страницы тоже нет', (await catalogAgentById(noObjects.id)) === null);

    // Валюты каталога — для подписи поля «цена до». Поле без валюты
    // оставляет человека гадать, вводить 800 или 70 000.
    // Черновику задаём ДРУГУЮ валюту: на одинаковой проверка проходила бы
    // и без фильтра по публикации — что и показала мутация.
    await db.prepare(`update objects set currency = 'KGS' where id = ?`)
      .bind(hidden.id).run();

    const money = await catalogCurrencies();
    check('валюты каталога берутся из опубликованных объектов',
      money.includes('USD'), money.join(', '));
    check('а валюта черновика в список не идёт',
      !money.includes('KGS'), money.join(', '));
    check('и без повторов', money.length === new Set(money).size, money.join(', '));

    // Объекты на странице агента — те же, что в каталоге, и только его.
    //
    // Чужой объект здесь обязан быть ОПУБЛИКОВАННЫМ: на черновике
    // проверка проходила бы и без фильтра по агенту, потому что черновика
    // в каталоге нет в принципе. Проверено мутацией — первая версия с
    // черновиком её не поймала.
    await loginAs(db, vera);
    const hersPublished = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Чужая 7', price_minor: 2_200_000,
    });
    await createMandate({ object_id: hersPublished.id, kind: 'non_exclusive' });
    await publishObject(hersPublished.id);
    await loginAs(db, anna);

    const mine2 = await catalogPage({ agent: anna });
    check('на странице агента есть его объект',
      mine2.items.some((i) => i.id === shown.id));
    check('а объект коллеги — опубликованный — туда не попадает',
      mine2.items.every((i) => i.id !== hersPublished.id),
      mine2.items.map((i) => i.address).join(' | '));
    check('и в общем каталоге он при этом есть — значит дело в фильтре',
      (await catalogPage({})).items.some((i) => i.id === hersPublished.id));

    // Убираем за собой: дальше по прогону считаются объекты агентов, и
    // лишний объект Веры ломает счётчики. Правило простое — проверка не
    // должна менять то, на чём стоят соседние.
    await db.prepare('delete from mandates where object_id = ?')
      .bind(hersPublished.id).run();
    await db.prepare('delete from objects where id = ?').bind(hersPublished.id).run();

    // Неопубликованный объект агента не раскрывает.
    //
    // Проверять на `hidden` было бы самообманом: у него нет мандата, и
    // соединение пусто независимо от фильтра по публикации — проверка
    // проходила бы, даже если фильтр убрать. Поэтому заводим объект
    // С МАНДАТОМ, но без публикации: только так видно, что дело в
    // состоянии объекта, а не в отсутствии договора.
    const draftWithMandate = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Черновиковая 1',
      price_minor: 1_500_000,
    });
    await createMandate({ object_id: draftWithMandate.id, kind: 'non_exclusive' });

    check('у черновика есть активный мандат — значит проверка не пустая',
      Boolean(await activeMandateOf(draftWithMandate.id)));
    check('но агента витрина по нему не отдаёт',
      (await catalogAgent(draftWithMandate.id)) === null);

    await updateProfile({ works_since: null, certificate_no: null });

    // -----------------------------------------------------------------
    // Фид для площадок
    // -----------------------------------------------------------------
    // Коннекторов к house.kg и lalafo нет: открытой документации по их
    // выгрузке не существует, и писать код к неизвестному формату — это
    // код, который выглядит готовым и рассыпается при встрече с
    // площадкой. Вместо этого постоянный адрес с файлом в общепринятом
    // формате: ссылку отдают площадке, дальше она читает сама.
    //
    // Фид уходит наружу целиком и навсегда. Забрать из него поле нельзя,
    // поэтому проверяется прежде всего состав, а не разметка.

    await updateObject(shown.id, {
      description: 'Светлая «трёшка» < 5 минут до парка & школы',
      photos: ['/photos/objects/x/y.jpg', 'https://чужой.хостинг/1.jpg'],
    });

    const feed = await feedXml('https://liberterra.kg');

    check('опубликованный объект в фиде есть', feed.includes(shown.id));
    check('черновика в фиде нет', !feed.includes(hidden.id));

    // То же, что и для витрины, но строже: здесь утечка необратима.
    check('в фиде нет ни агента, ни собственника, ни телефона',
      !feed.includes(anna) && !feed.includes('Собственник витрины')
      && !feed.includes('0555 12 13 14'));

    // Описание пишет человек, и «<» в нём — обычное дело. Без
    // экранирования одна скобка ломает весь файл, а не одно объявление.
    check('угловая скобка и амперсанд из описания экранированы',
      feed.includes('&lt; 5 минут') && feed.includes('&amp; школы')
      && !feed.includes('< 5 минут'));

    // Файл читает чужой сервер: «/photos/…» он не разрешит.
    check('свой снимок стал полным адресом',
      feed.includes('https://liberterra.kg/photos/objects/x/y.jpg'));
    check('чужая ссылка осталась как есть',
      feed.includes('https://чужой.хостинг/1.jpg'));

    // Тип сделки на языке площадки.
    check('продажа названа продажей', feed.includes('<type>продажа</type>'));
    check('вид объекта переведён', feed.includes('<category>квартира</category>'));

    // Телефон агентства. Витрина телефонов не отдаёт вовсе — там номера
    // собственников, — поэтому в фиде он один и общий, из настройки.
    //
    // Проверяется в обе стороны. Без настройки блок контакта не выводится
    // совсем: пустой <phone> хуже отсутствующего, площадка примет его за
    // настоящий, и по объявлению будут звонить в никуда.
    check('без настройки контакта в фиде нет',
      !feed.includes('<sales-agent>'));

    setEnv({ ...(env as unknown as Record<string, unknown>),
      FEED_PHONE: '0700 11 22 33', FEED_ORG: 'Liberterra' });
    const withPhone = await feedXml('https://liberterra.kg');

    check('телефон агентства попадает в фид',
      withPhone.includes('<phone>+996700112233</phone>'));
    check('номер приведён к международному виду',
      !withPhone.includes('0700 11 22 33'));
    check('название агентства рядом с телефоном',
      withPhone.includes('<organization>Liberterra</organization>'));

    // У агентства обычно две линии, и в объявлении полезны обе: по одной
    // не дозвонились — звонят по второй.
    setEnv({ ...(env as unknown as Record<string, unknown>),
      FEED_PHONE: '+996 505 804 402, +996 500 804 402', FEED_ORG: 'Liberterra' });
    const twoPhones = await feedXml('https://liberterra.kg');

    check('оба номера агентства в фиде',
      twoPhones.includes('<phone>+996505804402</phone>')
      && twoPhones.includes('<phone>+996500804402</phone>'));
    check('оба номера в одном контакте, а не в двух',
      twoPhones.split('<sales-agent>').length - 1
      === twoPhones.split('<offer ').length - 1);

    // Человек правит настройку руками: лишняя запятая, перенос строки и
    // повтор не должны ни ломать файл, ни плодить один номер дважды.
    setEnv({ ...(env as unknown as Record<string, unknown>),
      FEED_PHONE: '0505 804 402,\n, 0505804402 ; мусор', FEED_ORG: 'Liberterra' });
    const messy = await feedXml('https://liberterra.kg');

    check('повтор номера не удваивается, мусор отброшен',
      (messy.split('<phone>').length - 1) === (messy.split('<offer ').length - 1));

    // Мусор вместо номера — не номер. Лучше без контакта, чем с ломаным.
    setEnv({ ...(env as unknown as Record<string, unknown>), FEED_PHONE: '12' });
    check('непохожий на номер телефон в фид не идёт',
      !(await feedXml('https://liberterra.kg')).includes('<sales-agent>'));

    // Телефона собственника в фиде нет и при включённом контакте.
    setEnv({ ...(env as unknown as Record<string, unknown>),
      FEED_PHONE: '0700 11 22 33', FEED_ORG: 'Liberterra' });
    check('телефон собственника в фид не просочился',
      !(await feedXml('https://liberterra.kg')).includes('555121314'));

    // -----------------------------------------------------------------
    // Фид MHouse
    // -----------------------------------------------------------------
    // У площадки свой формат и свои справочники: значение не из списка
    // она не примет, а без обязательного поля не опубликует объявление.
    // Поэтому здесь проверяется не разметка, а отбор: уходит ли наружу
    // то, что площадка возьмёт, и остаётся ли дома то, что она отклонит.

    setEnv({ ...(env as unknown as Record<string, unknown>),
      FEED_PHONE: '0700 11 22 33', FEED_ORG: 'Liberterra' });

    const incomplete = await mhouseXml('https://liberterra.kg');
    check('без координат и серии квартира в фид MHouse не идёт',
      !incomplete.includes(shown.id));

    // Дозаполняем ровно то, чего требует площадка от квартиры.
    await updateObject(shown.id, {
      latitude: 42.819242, longitude: 74.619628,
      building_type: 'монолитный', serie: 'элитка',
      rooms: 3, area: 85.27, floor: 8, floors_total: 15,
    });

    const mhFull = await mhouseXml('https://liberterra.kg');
    check('заполненная квартира в фид MHouse идёт', mhFull.includes(shown.id));
    check('регион Бишкека подставлен по справочнику',
      mhFull.includes('<region>Чуйская область / Бишкек</region>'));
    check('координаты на месте',
      mhFull.includes('<latitude>42.819242</latitude>')
      && mhFull.includes('<longitude>74.619628</longitude>'));
    check('серия и тип дома на языке площадки',
      mhFull.includes('<serie>элитка</serie>')
      && mhFull.includes('<building-type>монолитный</building-type>'));
    // Микрорайон площадки — это наш район. Отдельного поля в карточке
    // нет, и значение берётся из того единственного, которое агент
    // заполняет: иначе два поля разошлись бы в первую же правку.
    check('микрорайон уходит в фид из нашего района',
      mhFull.includes('<micro-district>Центр</micro-district>'));

    check('контакт MHouse называет имя и роль подающего',
      mhFull.includes('<owner-type>агент</owner-type>')
      && mhFull.includes('<name>Liberterra</name>'));

    // Главное правило витрины держится и здесь: фид уходит наружу
    // навсегда, и собственник в нём невозможен.
    check('в фиде MHouse нет ни агента, ни собственника, ни его телефона',
      !mhFull.includes(anna) && !mhFull.includes('Собственник витрины')
      && !mhFull.includes('555121314'));

    // Значение не из справочника площадка не примет. Пропустить такое
    // поле — потерять объявление целиком, поэтому оно и не выводится.
    await updateObject(shown.id, { serie: 'какая-то своя серия' });
    const bogus = await mhouseXml('https://liberterra.kg');
    check('выдуманная серия не уходит в фид и уносит объявление с собой',
      !bogus.includes('какая-то своя серия') && !bogus.includes(shown.id));
    await updateObject(shown.id, { serie: 'элитка' });

    // Аренда без срока — отказ площадки, и объявление остаётся дома.
    const rentNoTerm = await createObject({
      kind: 'flat', deal_type: 'rent', address: 'Арендная 3',
      price_minor: 3_500_000, rooms: 1, area: 40, floor: 2, floors_total: 9,
      latitude: 42.8, longitude: 74.6,
      building_type: 'панельный', serie: '105 серия',
      description: 'Сдаётся', photos: ['/photos/a.jpg'],
    });
    await createMandate({ object_id: rentNoTerm.id, kind: 'non_exclusive' });
    await publishObject(rentNoTerm.id);
    check('аренда без срока в фид MHouse не идёт',
      !(await mhouseXml('https://liberterra.kg')).includes(rentNoTerm.id));

    await updateObject(rentNoTerm.id, { rental_term: 'на долгий срок' });
    const withTerm = await mhouseXml('https://liberterra.kg');
    check('со сроком аренда уходит в фид',
      withTerm.includes(rentNoTerm.id)
      && withTerm.includes('<rental-term>на долгий срок</rental-term>'));

    // Без контакта площадка не примет ни одного объявления: фид пустой.
    setEnv({ ...(env as unknown as Record<string, unknown>), FEED_PHONE: '' });
    const noAgent = await mhouseXml('https://liberterra.kg');
    check('без телефона агентства фид MHouse пуст',
      !noAgent.includes('<offer ') && noAgent.includes('</realty-feed>'));

    setEnv(env as unknown as Record<string, unknown>);

    // -----------------------------------------------------------------
    // Город
    // -----------------------------------------------------------------
    // Раньше города не было вовсе: в выгрузке он подставлялся константой
    // «Бишкек». Это держалось ровно до первого объекта из другого города
    // — и тот молча уехал бы в фид как бишкекский.

    const osh = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Ленина 10', city: 'Ош',
      rooms: 2, area: 50, price_minor: 3_000_000,
    });
    await createMandate({ object_id: osh.id, kind: 'non_exclusive' });
    await publishObject(osh.id);

    const cities = await feedXml('https://liberterra.kg');
    check('город объекта попадает в фид',
      cities.includes('<locality-name>Ош</locality-name>'));
    check('бишкекский объект остался бишкекским',
      cities.includes('<locality-name>Бишкек</locality-name>'));

    check('объект без города считается бишкекским',
      (await createObject({
        kind: 'flat', deal_type: 'sale', address: 'Безгорода 1',
        price_minor: 1_000_000,
      })).city === 'Бишкек');

    // Город ищется наравне с адресом: иначе «Ош» в поиске не находит
    // ошских объектов, хотя город у них записан.
    check('объект находится по городу',
      (await catalogPage({ q: 'ош' })).items.some((i) => i.id === osh.id));

    // Правка города пересобирает текст поиска. Без этого объект остался
    // бы находиться по прежнему городу и не находился по новому.
    await updateObject(osh.id, { city: 'Джалал-Абад' });
    check('после переезда находится по новому городу',
      (await catalogPage({ q: 'джалал' })).items.some((i) => i.id === osh.id));
    check('и больше не находится по прежнему',
      !(await catalogPage({ q: 'ош' })).items.some((i) => i.id === osh.id));

    // Пустой город — не «без города», а Бишкек: колонка обязательная, и
    // пустая строка означала бы объект без города в выгрузке.
    await updateObject(osh.id, { city: '   ' });
    check('пустой город при правке становится Бишкеком',
      (await catalogObject(osh.id))?.city === 'Бишкек');

    // Фильтр по городу. Показывается он, только когда городов больше
    // одного, и решает это сам список: выбор из одного пункта ничего не
    // решает, а место на пульте занимает.
    //
    // Город возвращаем: проверка выше нарочно сделала его бишкекским.
    await updateObject(osh.id, { city: 'Ош' });

    const cityList = await catalogCities();
    check('города витрины — те, что есть у опубликованных объектов',
      cityList.includes('Ош') && cityList.includes('Бишкек'));

    const onlyOsh = await catalogPage({ city: 'Ош' });
    check('фильтр по городу отбирает только его объекты',
      onlyOsh.items.length > 0 && onlyOsh.items.every((i) => i.city === 'Ош'));
    check('бишкекские при этом не попадают',
      !onlyOsh.items.some((i) => i.id === shown.id));

    // Счётчик на кнопке «Найти» обязан считать то же, что покажет список.
    check('счётчик согласен с выдачей',
      (await catalogCount({ city: 'Ош' })) === onlyOsh.total);

    check('без фильтра видны все города',
      (await catalogPage({})).items.some((i) => i.city === 'Ош')
      && (await catalogPage({})).items.some((i) => i.city === 'Бишкек'));

    // Разбор адреса страницы. Без этого фильтр мог бы работать в базе и
    // при этом теряться по дороге от ссылки до запроса — ровно так и
    // прошла молча мутация «город теряется при разборе».
    const parsed = parseCatalogFilters({ city: 'Ош', kind: 'flat', rooms: '2' });
    check('город читается из адреса страницы', parsed.city === 'Ош');
    check('город переживает сборку ссылки обратно',
      catalogHref('ru', parsed, 1).includes('city=%D0%9E%D1%88'));
    // Город ОДИН, без прочих полей: иначе проверка истинна и без него —
    // ровно так мутация «город не считается фильтром» и прошла молча.
    check('один только город уже считается фильтром',
      hasAnyFilter(parseCatalogFilters({ city: 'Ош' })));
    check('пустой город за фильтр не считается',
      parseCatalogFilters({ city: '  ' }).city === null
      && !hasAnyFilter(parseCatalogFilters({ city: '  ' })));

    // Районы считаются по выбранному городу. Иначе «Центр» складывал бы
    // центр Бишкека с центром Оша в одно число, а нажатие на него
    // приводило бы в список из двух разных городов — прямая ложь в цифре.
    //
    // У обоих объектов зона «Центр» нарочно: совпадение названий районов
    // в разных городах — обычное дело, и именно на нём ошибка и вылезает.
    await updateObject(osh.id, { zone: 'Центр' });

    const allZones = await catalogZoneCounts(null, null);
    const oshZones = await catalogZoneCounts(null, 'Ош');
    const bishkekZones = await catalogZoneCounts(null, 'Бишкек');

    const centre = (list: Array<{ zone: string; n: number }>) =>
      list.find((z) => z.zone === 'Центр')?.n ?? 0;

    check('без города Центр считает оба города',
      centre(allZones) === centre(oshZones) + centre(bishkekZones)
      && centre(allZones) > centre(oshZones));
    check('с городом Центр считает только его',
      centre(oshZones) === 1);
    check('чужой район в чужом городе не появляется',
      !oshZones.some((z) => z.zone === 'Чүй'));

    // -----------------------------------------------------------------
    // Карточка агента: стаж, сертификат, аватарка
    // -----------------------------------------------------------------
    // Эти поля видит КЛИЕНТ, и потому сертификат устроен как агентство:
    // агент заявляет, админ сверяет. Непроверенное утверждение от имени
    // агентства — обман, даже если агент не хотел обманывать.

    await loginAs(db, vera);
    await updateProfile({ works_since: 2019, certificate_no: 'КР-12345' });

    const veraCard = await getAgent(vera);
    check('стаж хранится годом начала, а не числом лет',
      veraCard?.works_since === 2019);
    check('номер сертификата записан', veraCard?.certificate_no === 'КР-12345');
    check('но не подтверждён сам собой', veraCard?.certificate_confirmed === 0);

    // Год из будущего — не стаж, а опечатка.
    await throws('год начала из будущего отвергается',
      () => updateProfile({ works_since: new Date().getUTCFullYear() + 1 }), Invalid);
    await throws('год до 1990 отвергается',
      () => updateProfile({ works_since: 1980 }), Invalid);

    // Подтверждает только админ.
    await throws('агент не подтверждает свой сертификат сам',
      () => confirmAgentCertificate(vera, true), Forbidden);

    await loginAs(db, anna);
    await confirmAgentCertificate(vera, true);
    check('админ подтверждает сертификат',
      (await getAgent(vera))?.certificate_confirmed === 1);

    // ГЛАВНОЕ. Порядок обходится в два приёма: вписать настоящий номер,
    // дождаться отметки, подменить на любой другой — и остаться с
    // галочкой. Смена номера обязана сбрасывать подтверждение.
    await loginAs(db, vera);
    await updateProfile({ certificate_no: 'КР-99999' });
    const reclaimed = await getAgent(vera);
    check('смена номера сбрасывает подтверждение',
      reclaimed?.certificate_no === 'КР-99999'
      && reclaimed?.certificate_confirmed === 0,
      `подтверждение осталось ${reclaimed?.certificate_confirmed}`);

    // Пустое поле подтверждать нечего: иначе отметка повиснет на пустоте,
    // а номер впишут потом.
    await updateProfile({ certificate_no: null });
    await loginAs(db, anna);
    await throws('пустой сертификат не подтверждается',
      () => confirmAgentCertificate(vera, true), Invalid);

    // Аватарка. Ключ детерминированный: новая затирает старую, а не
    // копится рядом.
    await loginAs(db, vera);
    const avaJpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])]);
    const ava = await putAvatar(avaJpeg);
    check('аватарка лежит по имени агента', ava.key === `avatars/${vera}.jpg`);
    check('ключ записан в карточку агента',
      (await getAgent(vera))?.avatar_key === ava.key);
    check('аватарка отдаётся посетителю',
      (await readPhoto(ava.key))?.type === 'image/jpeg');

    const avaPng = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])]);
    const ava2 = await putAvatar(avaPng);
    check('другой формат не плодит вторую аватарку',
      ava2.key === `avatars/${vera}.png`
      && (await readPhoto(ava.key)) === null);

    await throws('не-картинка аватаркой не становится',
      () => putAvatar(new Blob(['<?php ?>'])), Invalid);

    await deleteAvatar();
    check('аватарка убирается и из хранилища, и из карточки',
      (await readPhoto(ava2.key)) === null
      && (await getAgent(vera))?.avatar_key === null);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Привязка Telegram агентом самостоятельно
    // -----------------------------------------------------------------
    // Раньше telegram_id проставлял админ по присланному номеру — и верил
    // человеку на слово: проверить, чей это номер, было нечем. Теперь
    // идентификатор приходит от Telegram, а не от человека.

    await loginAs(db, vera);
    setEnv({ ...(env as unknown as Record<string, unknown>),
      TELEGRAM_BOT_USERNAME: '@liberterra_bot' });

    const link = await startTelegramLink();
    check('ссылка ведёт к боту и несёт код',
      link.url.startsWith('https://t.me/liberterra_bot?start=')
      && link.url.length > 'https://t.me/liberterra_bot?start='.length + 32);
    const code = link.url.split('start=')[1];

    // Кода в базе нет — только его отпечаток. Утечка таблицы не даёт
    // привязать чужой Telegram, ровно как при входе по почте.
    const storedCode = await db.prepare(
      'select code_hash from telegram_links where agent_id = ?',
    ).bind(vera).first<{ code_hash: string }>();
    check('в базе лежит отпечаток, а не сам код',
      storedCode !== null && storedCode.code_hash !== code);

    // Бот не настроен — честный отказ, а не ссылка в никуда.
    setEnv({ ...(env as unknown as Record<string, unknown>), TELEGRAM_BOT_USERNAME: '' });
    await throws('без настроенного бота ссылка не выдаётся',
      () => startTelegramLink(), Invalid);
    setEnv({ ...(env as unknown as Record<string, unknown>),
      TELEGRAM_BOT_USERNAME: 'liberterra_bot' });

    // Главное: код привязывает ТОГО агента, который его запросил, а не
    // того, кто прислал сообщение.
    await completeTelegramLink(code, 777000111);
    check('привязался агент, запросивший код',
      (await getAgent(vera))?.telegram_id === 777000111);

    // Одноразовость. Повтор — отказ, а не вторая привязка.
    await throws('код срабатывает один раз',
      () => completeTelegramLink(code, 777000222), Forbidden);
    check('повтор ничего не переписал',
      (await getAgent(vera))?.telegram_id === 777000111);

    await throws('выдуманный код не привязывает',
      () => completeTelegramLink('не-код', 777000333), Forbidden);

    // Один Telegram — один агент. Иначе напоминания двух агентов пришли бы
    // в один чат, и неясно, чьи именно.
    await loginAs(db, anna);
    const annaLink = await startTelegramLink();
    await throws('чужой Telegram не привязать вторым',
      () => completeTelegramLink(annaLink.url.split('start=')[1], 777000111), Conflict);

    // Протухший код. Срок короткий намеренно: код уходит в чат.
    const stale = await startTelegramLink();
    await db.prepare(
      `update telegram_links set expires_at = ? where used_at is null and agent_id = ?`,
    ).bind('2000-01-01T00:00:00.000Z', anna).run();
    await throws('протухший код не привязывает',
      () => completeTelegramLink(stale.url.split('start=')[1], 777000444), Forbidden);

    check('уборка уносит протухшие коды',
      (await sweepTelegramLinks()) > 0);

    // Отвязка. Без неё единственным выходом был бы админ — то есть ровно
    // то, от чего уходили.
    await loginAs(db, vera);
    await unlinkTelegram();
    check('агент отвязывает свой Telegram',
      (await getAgent(vera))?.telegram_id === null);

    // Привязка — то же право, что и правка своей карточки: ожидающему
    // одобрения напоминания нужны с первого дня, а одобрения можно ждать
    // сутки. Заблокированному закрыто всё.
    await loginAs(db, newcomer.id);
    const pendingLink = await startTelegramLink();
    await completeTelegramLink(pendingLink.url.split('start=')[1], 777000555);
    check('ожидающий одобрения тоже может привязать',
      (await getAgent(newcomer.id))?.telegram_id === 777000555);
    await unlinkTelegram();

    await db.prepare(`update agents set status = 'blocked' where id = ?`)
      .bind(newcomer.id).run();
    await throws('заблокированный Telegram не привязывает',
      () => startTelegramLink(), Forbidden);
    await db.prepare(`update agents set status = 'pending' where id = ?`)
      .bind(newcomer.id).run();

    // -----------------------------------------------------------------
    // Обработчик бота: подлинность запроса
    // -----------------------------------------------------------------
    // Это граница безопасности всей затеи. Маршрут открыт в интернет и
    // входа не спрашивает — спрашивать нечего, запрос приходит от
    // Telegram. Кто угодно мог бы прислать «/start <чужой код>» со своим
    // идентификатором и забрать чужие напоминания. Единственное, что это
    // останавливает, — секретный заголовок.
    const update = (text: string, fromId: number) => JSON.stringify({
      message: { text, from: { id: fromId }, chat: { id: fromId } },
    });
    const hit = (body: string, header?: string) => telegramWebhook(new Request(
      'https://liberterra.kg/api/telegram/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(header === undefined ? {} : { 'x-telegram-bot-api-secret-token': header }),
        },
        body,
      },
    ));

    await loginAs(db, vera);
    const viaBot = (await startTelegramLink()).url.split('start=')[1];

    // Секрет не задан — маршрут отключён целиком. Открытый обработчик
    // хуже неработающей привязки: неработающую видно сразу.
    delete (process.env as Record<string, string | undefined>).TELEGRAM_WEBHOOK_SECRET;
    check('без секрета обработчик отключён',
      (await hit(update(`/start ${viaBot}`, 777111000))).status === 503);
    check('и ничего не привязал',
      (await getAgent(vera))?.telegram_id === null);

    process.env.TELEGRAM_WEBHOOK_SECRET = 'настоящий-секрет';

    check('без заголовка — отказ',
      (await hit(update(`/start ${viaBot}`, 777111000))).status === 401);
    check('с чужим секретом — отказ',
      (await hit(update(`/start ${viaBot}`, 777111000), 'подделка')).status === 401);
    check('после отказов привязки нет',
      (await getAgent(vera))?.telegram_id === null);

    // С верным секретом — привязка проходит.
    check('с верным секретом обработчик отвечает 200',
      (await hit(update(`/start ${viaBot}`, 777111000), 'настоящий-секрет')).status === 200);
    check('привязка состоялась',
      (await getAgent(vera))?.telegram_id === 777111000);

    // Остальные сообщения боту — не ошибка: он служебный, а не
    // собеседник. Отвечаем 200, иначе Telegram повторял бы обновление
    // бесконечно.
    check('постороннее сообщение не роняет обработчик',
      (await hit(update('привет', 777111000), 'настоящий-секрет')).status === 200);
    check('мусор вместо тела тоже',
      (await hit('не json', 'настоящий-секрет')).status === 200);

    await loginAs(db, vera);
    await unlinkTelegram();

    await loginAs(db, anna);
    setEnv(env as unknown as Record<string, unknown>);

    // География: регион → город → район. Три уровня нужны не ради
    // стройности, а потому что так спрашивает человек и потому что
    // площадка задумана шире одной области.
    check('регионы перечислены', regions().length > 1);
    check('город знает свой регион', regionOf('Бишкек') === 'Чуйская область');
    check('город вне словаря региона не выдумывает', regionOf('Ташкент') === null);
    check('у региона есть города', citiesOf('Иссык-Кульская область').includes('Каракол'));
    check('без региона города всех регионов', citiesOf(null).includes('Ош'));

    check('у Бишкека районы перечислены', zonesOf('Бишкек').length > 0);
    check('у города без списка его нет, и это не сбой', zonesOf('Ош').length === 0);
    check('пустой город районов не получает',
      zonesOf(null).length === 0 && zonesOf('').length === 0);

    // Названия в списке обязаны совпадать с тем, что агенты пишут в поле
    // зоны: иначе выбор района в поиске не найдёт ни одного объекта.
    const bishkek = zonesOf('Бишкек');
    check('в списке есть Центр — та же зона, что у объектов витрины',
      bishkek.includes('Центр'));
    check('микрорайоны в списке есть, и они первые',
      bishkek[0] === '3 микрорайон' && bishkek.includes('6 микрорайон'));

    // Номер микрорайона пишут тремя способами, и каждый обязан найтись:
    // человек не должен угадывать, как его записали в карточке.
    check('«6 мкр», «6 м-н» и «6 микрорайон» — одно место',
      zoneMatch('6 микрорайон', '6 мкр') && zoneMatch('6 микрорайон', '6 м-н')
      && zoneMatch('6 микрорайон', '6микрорайон'));
    check('дефисы и регистр не мешают', zoneMatch('Кок-Жар', 'кокжар'));
    check('чужой район не находится', !zoneMatch('Асанбай', 'джал'));

    // Как сайт себя называет. Пока город один — он; городов несколько —
    // страна. Текст считается по каталогу, а не правится руками: иначе
    // «Платформа для профессионалов, Бишкек» в подвале устареет ровно в
    // тот день, когда кто-то заведёт объект в Оше, и никто не вспомнит.
    const ru = t('ru');
    check('при нескольких городах в подвале страна',
      placeName(await catalogCities(), ru) === 'Кыргызстан');
    check('при одном городе — он сам',
      placeName(['Ош'], ru) === 'Ош');
    check('пустой каталог остаётся бишкекским',
      placeName([], ru) === 'Бишкек');
    check('подпись собирается на всех языках',
      t('ky').agencyLine('Ош').includes('Ош')
      && t('en').agencyLine('Osh').includes('Osh')
      && t('zh').agencyLine('奥什').includes('奥什'));

    // Разметка для поисковика. Город там был зашит константой — той же
    // ошибкой, что и в выгрузке: объект из Оша поисковик увидел бы
    // бишкекским и показал бы его не тем людям.
    const oshItem = await catalogObject(osh.id);
    const schema = JSON.stringify(
      listingSchema(oshItem as never, 'ru', 'Ленина 10'),
    );
    check('поисковик видит настоящий город объекта',
      schema.includes('"addressLocality":"Ош"'));
    check('и не видит зашитого Бишкека', !schema.includes('Бишкек'));

    await withdrawObject(osh.id);

    check('снятый с публикации город из списка уходит',
      !(await catalogCities()).includes('Ош'));

    // Аренда и продажа должны называться по-разному. Проверка на одну
    // продажу этого не ловит: мутация «всё — продажа» проходит молча.
    const rented = await createObject({
      kind: 'house', deal_type: 'rent', address: 'Дачная 7',
      price_minor: 40_000,
    });
    await createMandate({ object_id: rented.id, kind: 'non_exclusive' });
    await publishObject(rented.id);

    const both = await feedXml('https://liberterra.kg');
    check('аренда названа арендой, а не продажей',
      both.includes('<type>аренда</type>') && both.includes('<type>продажа</type>'));
    check('дом назван домом', both.includes('<category>дом</category>'));

    await withdrawObject(rented.id);

    // Коммерческий объект в выгрузку НЕ попадает: точного значения для
    // него в справочнике я проверить не смог, а выдуманное сделало бы
    // невалидным весь файл, а не одну запись. Записано в README.
    const commercial = await createObject({
      kind: 'commercial', deal_type: 'rent', address: 'Торговая 1',
      price_minor: 2_000_000,
    });
    await createMandate({ object_id: commercial.id, kind: 'non_exclusive' });
    await publishObject(commercial.id);

    const withCommercial = await feedXml('https://liberterra.kg');
    check('коммерческий объект в фид не попадает',
      !withCommercial.includes(commercial.id));

    // Кабинет предупреждает об этом, и предупреждение завязано на ТОТ ЖЕ
    // словарь, из которого строится фид. Без связки «commercial» однажды
    // появится в фиде, а кабинет продолжит писать «не попадает».
    check('кабинет знает, что коммерческий в выгрузку не идёт', !inFeed('commercial'));
    check('и что квартира идёт', inFeed('flat'));
    check('согласовано с самим фидом: что фид отдаёт, то inFeed и признаёт',
      withCommercial.includes(forSale.id) === inFeed('flat'));
    check('а в витрине он при этом есть — значит дело в фиде, а не в публикации',
      (await catalogPage({})).items.some((i) => i.id === commercial.id));

    // Склад на витрине подписан складом, а не «коммерческой».
    //
    // Точный вид берётся из commercial_type — того самого поля, которое
    // агент заполняет обязательно ради фида. Второго словаря для этого
    // нет нарочно: он разошёлся бы с первым.
    await updateObject(commercial.id, { commercial_type: 'склады' });
    const warehouse = (await catalogPage({})).items
      .find((i) => i.id === commercial.id);
    check('витрина отдаёт вид коммерции', warehouse?.commercial_type === 'склады');
    check('и показывает его складом',
      spaceName('ru', warehouse!) === 'склад', spaceName('ru', warehouse!));
    // На другом языке — своим словом, а не русским: витрина четырёхъязычна,
    // а значения площадки русские.
    check('на другом языке — словом этого языка',
      spaceName('en', warehouse!) === 'warehouse', spaceName('en', warehouse!));

    // Жилья этот слой не касается: у квартиры вид точен сам. И остаётся
    // точным, даже если вид коммерции в записи заполнен: агент мог
    // перевести объект из коммерческой в жильё, а поле осталось. Квартира,
    // подписанная складом, — худшее, что может сделать эта подпись.
    await updateObject(forSale.id, { commercial_type: 'склады' });
    const flatShown = (await catalogPage({})).items.find((i) => i.id === forSale.id);
    check('вид коммерции у квартиры в записи остался',
      flatShown?.commercial_type === 'склады');
    check('но квартира остаётся квартирой',
      spaceName('ru', flatShown!) === 'квартира', spaceName('ru', flatShown!));
    await updateObject(forSale.id, { commercial_type: null });

    // «Другая коммерческая недвижимость» точнее «коммерческой» не стала:
    // подменять её выдуманной точностью нельзя.
    check('неточный вид не подменяется точным',
      commercialCode('другая коммерческая недвижимость') === null);
    check('незаполненный — тоже', commercialCode(null) === null);
    // Значения приходят не только из нашего select'а: разбор чужих
    // объявлений даёт их как попало. Приведение в JS, а не в SQL: в SQLite
    // lower() кириллицу не трогает.
    check('лишние пробелы и регистр узнать вид не мешают',
      commercialCode('  Склады ') === 'warehouse');
    // Иначе новое значение в справочнике площадки молча показывалось бы
    // «коммерческой», и никто бы не заметил.
    check('весь справочник площадки разобран, кроме «другой»',
      COMMERCIAL_TYPE.filter((v) => commercialCode(v) === null).length === 1,
      COMMERCIAL_TYPE.filter((v) => commercialCode(v) === null).join('; '));
    // Код без подписи вывел бы на карточку сам код: «warehouse» по-русски.
    check('у каждого вида коммерции есть подпись на всех языках',
      LANGS.every((l) => COMMERCIAL_TYPE.every((v) => {
        const code = commercialCode(v);
        return code === null || t(l).kinds[code] !== undefined;
      })));

    await withdrawObject(commercial.id);
    await updateObject(shown.id, { description: null, photos: [] });

    // Поиск: кыргызские буквы в обоих написаниях.
    const byKg = await catalogPage({ q: 'Чүй' });
    const byRu = await catalogPage({ q: 'чуй' });
    check('«чуй» находит «Чүй»',
      byRu.items.some((i) => i.id === shown.id)
      && byKg.items.some((i) => i.id === shown.id));

    // Запятая в запросе не должна ничего ронять.
    const comma = await catalogPage({ q: 'Чүй, кв' });
    check('запятая в поиске не роняет запрос', Array.isArray(comma.items));

    // Фильтры.
    const byRooms = await catalogPage({ rooms: 3 });
    check('фильтр по комнатам работает',
      byRooms.items.every((i) => i.rooms === 3)
      && byRooms.items.some((i) => i.id === shown.id));

    const byPrice = await catalogPage({ priceMax: 100_000 });
    check('фильтр по цене считает в основных единицах, а не в минорных',
      byPrice.items.some((i) => i.id === shown.id),
      `нашлось ${byPrice.items.length}`);

    check('зоны витрины перечисляются', (await catalogZones()).includes('Центр'));

    // Правка адреса меняет и то, по чему объект находится. Иначе он
    // остаётся найденным по прежнему адресу и не находится по новому —
    // ошибка тихая, видна только человеку, который ищет и не находит.
    await updateObject(shown.id, { address: 'Ибраимова 45' });
    const byNew = await catalogPage({ q: 'ибраимова' });
    const byOld = await catalogPage({ q: 'Чүй 200' });
    check('после правки объект находится по новому адресу',
      byNew.items.some((i) => i.id === shown.id));
    check('и больше не находится по старому',
      !byOld.items.some((i) => i.id === shown.id));

    // Снятый с публикации уходит из витрины.
    await withdrawObject(shown.id);
    check('снятый объект из витрины уходит',
      (await catalogObject(shown.id)) === null);
    await publishObject(shown.id);

    // -----------------------------------------------------------------
    // Кабинет: то, что раньше держала RLS
    // -----------------------------------------------------------------
    // Это главная проверка всего переезда. В Postgres списки фильтровала
    // политика: забудь страница условие — база всё равно не отдала бы
    // чужую строку. Здесь страховки нет, условие живёт в запросе, и
    // проверять его надо прицельно.
    await loginAs(db, anna);
    const annaContact = await createContact({ name: 'Клиент Анны-2', phone: '0500 11 22 33' });
    const annaObject = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Анны 1', price_minor: 5_000_000,
      owner_contact_id: annaContact.id,
    });

    await loginAs(db, vera);
    const veraContact = await createContact({ name: 'Клиент Веры', phone: '0500 44 55 66' });

    const veraSees = (await contactList()).rows;
    check('чужих контактов в списке нет',
      !veraSees.some((c) => c.id === annaContact.id),
      `видно ${veraSees.length} контактов`);
    check('свои контакты в списке есть',
      veraSees.some((c) => c.id === veraContact.id));

    // Объект виден всем — его ведёт коллега, это нормально, — но имя
    // собственника и право правки нет.
    const veraObjects = (await objectList()).rows;
    const foreign = veraObjects.find((o) => o.id === annaObject.id);
    check('чужой объект в списке виден', Boolean(foreign));
    check('имя собственника чужого объекта закрыто',
      foreign?.owner_name === null, `показано: ${foreign?.owner_name}`);
    check('править чужой объект нельзя', foreign?.can_edit === false);

    await loginAs(db, anna);
    const annaObjects = (await objectList()).rows;
    const own = annaObjects.find((o) => o.id === annaObject.id);
    check('своего собственника видно', own?.owner_name === 'Клиент Анны-2');
    check('свой объект править можно', own?.can_edit === true);

    check('объекты контакта видны владельцу записи',
      (await contactObjects(annaContact.id)).length === 1);
    await loginAs(db, vera);
    check('объекты чужого контакта не видны',
      (await contactObjects(annaContact.id)).length === 0);

    // Сделки: видит только сторона. Список разложен по вкладкам (идущие и
    // завершённые), и сделка лежит в той, куда попал её статус. Проверяем
    // обе: важно, что сторона её видит, а не в какой она вкладке.
    const everyDeal = async () => (await Promise.all(
      (['open', 'done'] as const).map((s) => dealList(null, 'desc', s)),
    )).flatMap((p) => p.rows);

    await loginAs(db, anna);
    const annaDeals = await everyDeal();
    check('сторона сделки свои сделки видит', annaDeals.length > 0);

    await loginAs(db, vera);
    const veraDeals = await everyDeal();
    check('посторонний чужих сделок не видит',
      veraDeals.length === 0, `видно ${veraDeals.length}`);

    // Потребности: клиент закрыт, сама потребность видна.
    await loginAs(db, boris);
    await db.prepare(`update agents set status = 'approved' where id = ?`).bind(boris).run();
    await loginAs(db, boris);
    const needs = (await requirementList()).rows;
    const someoneElse = needs.find((r) => r.agent_id !== boris);
    check('чужая потребность видна',
      needs.length > 0 && someoneElse !== undefined);
    check('имя клиента чужой потребности закрыто',
      someoneElse?.client_name === null, `показано: ${someoneElse?.client_name}`);

    // Счётчики главной считают своё, а не всё подряд.
    await loginAs(db, vera);
    const counters = await cabinetCounters();
    check('счётчики главной считают только своё',
      (counters?.open_deals ?? 0) === 0 && (counters?.objects ?? 0) === 0,
      `сделок ${counters?.open_deals}, объектов ${counters?.objects}`);

    await loginAs(db, anna);

    // -----------------------------------------------------------------
    // Снимки объектов
    // -----------------------------------------------------------------
    // Хранилище здесь настоящее: Miniflare держит R2 в памяти. Проверять
    // загрузку по заглушке бессмысленно — вся суть в том, что именно
    // принимает и отвергает хранилище.
    await loginAs(db, anna);
    const withPhotos = await createObject({
      kind: 'flat', deal_type: 'sale', address: 'Фотографическая 1',
      price_minor: 3_000_000,
    });

    // Настоящий JPEG: три байта подписи и немного содержимого.
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])]);
    const shot = await putPhoto(withPhotos.id, jpeg);

    check('снимок загружается', shot.url.startsWith('/photos/objects/'));
    check('тип определён по содержимому', shot.type === 'image/jpeg');
    check('путь относительный, без домена', !shot.url.includes('://'));

    const back = await readPhoto(shot.key);
    check('снимок читается обратно', back?.type === 'image/jpeg');
    check('путь и ключ переводятся друг в друга',
      photoKey(photoUrl(shot.key)) === shot.key);

    // Главное: тип берётся из содержимого, а НЕ из того, что сказал браузер.
    // Иначе чужой файл с подделанным типом мы бы отдали посетителю от
    // своего имени.
    const notAnImage = new Blob(['<?php echo "привет"; ?>'], { type: 'image/jpeg' });
    await throws('файл не-картинка отвергается, даже если назвался картинкой',
      () => putPhoto(withPhotos.id, notAnImage), Invalid);

    await throws('пустой файл отвергается',
      () => putPhoto(withPhotos.id, new Blob([])), Invalid);

    // Чужой объект — чужие снимки.
    await loginAs(db, vera);
    await throws('в чужой объект снимок не загрузить',
      () => putPhoto(withPhotos.id, jpeg), Forbidden);
    await throws('чужой снимок не удалить',
      () => deletePhoto(withPhotos.id, shot.key), Forbidden);

    await loginAs(db, anna);
    check('снимок на месте', (await listPhotos(withPhotos.id)).length === 1);

    // Ключ обязан принадлежать объекту: иначе удалением чужого ключа можно
    // вычистить снимки соседнего объекта.
    await throws('ключ от другого объекта не принимается',
      () => deletePhoto(withPhotos.id, `objects/${shown.id}/подделка.jpg`), Invalid);

    // -----------------------------------------------------------------
    // Миниатюры
    // -----------------------------------------------------------------
    // Сжатие происходит в браузере, и проверить его здесь нечем: ни
    // холста, ни createImageBitmap в Worker'е нет. Зато проверяемо
    // главное — что миниатюра сохраняется, отдаётся, не считается
    // отдельным снимком и уходит вместе со снимком.

    const webpThumb = new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4,
    ])]);
    const withThumb = await putPhoto(withPhotos.id, jpeg, webpThumb);

    check('миниатюра сохраняется рядом',
      (await readPhoto(thumbKey(withThumb.key)))?.type === 'image/webp');

    // Главное про лимит: миниатюра — не снимок. Иначе агент загрузил бы
    // десять снимков и исчерпал лимит в двадцать.
    check('миниатюра не считается снимком',
      (await listPhotos(withPhotos.id)).filter((k) => k.includes('@thumb')).length === 0);
    check('снимков ровно два, а файлов больше',
      (await listPhotos(withPhotos.id)).length === 2
      && (await env.PHOTOS.list({ prefix: `objects/${withPhotos.id}/` })).objects.length === 3);

    // Правило вывода адреса обратимо: иначе по имени миниатюры не
    // восстановить полный снимок, а маршрут отдачи делает именно это.
    check('правило адреса миниатюры обратимо',
      fullKeyOf(thumbKey(withThumb.key)) === withThumb.key);
    check('адрес миниатюры выводится из адреса снимка',
      thumbOf(withThumb.url) === photoUrl(thumbKey(withThumb.key)));
    check('чужая ссылка миниатюры не получает',
      thumbOf('https://чужой.хостинг/1.jpg') === 'https://чужой.хостинг/1.jpg'
      && !isOwnPhoto('https://чужой.хостинг/1.jpg'));

    // Запасной путь. Снимки, загруженные до появления сжатия, миниатюры не
    // имеют, а каталог всё равно попросит её — адрес он выводит по правилу,
    // не спрашивая хранилище. Без подстановки в карточке была бы дырка.
    check('без миниатюры отдаётся полный снимок',
      (await readPhoto(thumbKey(shot.key)))?.type === 'image/jpeg');

    // Миниатюра тоже приходит снаружи, тем же запросом: проверяется по
    // содержимому, как и снимок. Подделку кладём молча — терять из-за неё
    // сам снимок нельзя.
    const fakeThumb = new Blob(['<?php echo "и я картинка"; ?>']);
    const noThumb = await putPhoto(withPhotos.id, jpeg, fakeThumb);
    check('снимок принят, а миниатюра-подделка не положена',
      (await env.PHOTOS.get(noThumb.key)) !== null
      && (await env.PHOTOS.get(thumbKey(noThumb.key))) === null);
    check('вместо непринятой миниатюры отдаётся снимок',
      (await readPhoto(thumbKey(noThumb.key)))?.type === 'image/jpeg');

    // -----------------------------------------------------------------
    // Пересчёт миниатюр
    // -----------------------------------------------------------------
    // Нужен двум видам снимков: загруженным до появления сжатия и
    // пришедшим из браузеров без OffscreenCanvas. Второй случай не
    // исторический — он будет повторяться.
    //
    // Сам пересчёт делает браузер: уменьшить картинку в Worker'е нечем.
    // Здесь проверяется серверная половина — кого пускают, что находят и
    // что кладут.

    // anna к этому месту уже админ — её повысили в блоке про роли.
    const missing = await photosMissingThumb();

    // shot и noThumb миниатюр не имеют, withThumb имеет.
    check('перечень находит снимки без миниатюр',
      missing.keys.includes(shot.key) && missing.keys.includes(noThumb.key));
    check('снимок с миниатюрой в перечень не попадает',
      !missing.keys.includes(withThumb.key));
    check('сами миниатюры за снимки не считаются',
      missing.keys.every((k) => !k.includes('@thumb')));

    // Обзор всего хранилища — не дело рядового агента.
    await loginAs(db, vera);
    await throws('перечень закрыт для не-админа',
      () => photosMissingThumb(), Forbidden);

    // Права на запись — те же, что на правку объекта.
    await throws('чужую миниатюру не достроить',
      () => putThumb(withPhotos.id, shot.key, webpThumb), Forbidden);

    await loginAs(db, anna);

    // Ключ обязан принадлежать объекту: иначе чужим ключом подменяется
    // миниатюра соседнего объекта.
    await throws('ключ от другого объекта пересчёт не принимает',
      () => putThumb(withPhotos.id, `objects/${shown.id}/чужой.jpg`, webpThumb), Invalid);

    // Пересчёт достраивает к существующему, а не заводит новое: снимка
    // нет — и достраивать нечего.
    await throws('миниатюра без снимка не кладётся',
      () => putThumb(withPhotos.id, `objects/${withPhotos.id}/${'0'.repeat(8)}.jpg`, webpThumb),
      NotFound);

    // Содержимое проверяется и здесь: миниатюра приходит снаружи.
    await throws('подделка вместо миниатюры отвергается',
      () => putThumb(withPhotos.id, shot.key, fakeThumb), Invalid);

    await putThumb(withPhotos.id, shot.key, webpThumb);
    check('пересчёт кладёт миниатюру к старому снимку',
      (await readPhoto(thumbKey(shot.key)))?.type === 'image/webp');
    check('пересчёт не завёл нового снимка',
      (await listPhotos(withPhotos.id)).length === 3);

    const after = await photosMissingThumb();
    check('пересчитанный снимок из перечня уходит',
      !after.keys.includes(shot.key));

    await loginAs(db, anna);

    await deletePhoto(withPhotos.id, withThumb.key);
    check('миниатюра удаляется вместе со снимком',
      (await env.PHOTOS.get(thumbKey(withThumb.key))) === null);
    await deletePhoto(withPhotos.id, noThumb.key);

    // -----------------------------------------------------------------
    // Снимки доходят до формы правки списком, а не строкой
    // -----------------------------------------------------------------
    // В D1 колонка photos — текст с JSON; Postgres отдавал jsonb уже
    // разобранным. При переезде разница осталась незамеченной, потому что
    // страница правки приводила ответ через `as unknown as`. Проверка
    // типов замолчала, а страница падала в браузере на ЛЮБОМ объекте:
    // «.map is not a function». Нашлось это только загрузкой снимка на
    // живом сайте — ни один тест кабинета сюда не заглядывал.
    await updateObject(withPhotos.id, { photos: ['/photos/a.jpg', '/photos/b.jpg'] });
    const forEdit = await objectCard(withPhotos.id);

    check('карточка кабинета отдаёт снимки массивом, а не строкой',
      Array.isArray(forEdit?.photos));
    check('снимки в карточке те же, что записаны',
      forEdit?.photos.join('|') === '/photos/a.jpg|/photos/b.jpg');

    await updateObject(withPhotos.id, { photos: [] });

    await deletePhoto(withPhotos.id, shot.key);
    check('снимок удаляется', (await listPhotos(withPhotos.id)).length === 0);
    check('удалённый снимок не читается', (await readPhoto(shot.key)) === null);

    // Отдаём только ключи СВОЕГО вида, и это проверяется честно: кладём в
    // хранилище ключ чужого вида прямо, мимо putPhoto, и убеждаемся, что
    // маршрут отдачи его не отдаст.
    //
    // Проверять «не нашлось» бессмысленно: ненайденный ключ вернёт null и
    // без всякой проверки — именно так эта проверка однажды и оказалась
    // пустой.
    await env.PHOTOS.put('secrets/ключи.txt', 'не для посетителя');
    await env.PHOTOS.put('objects/../побег.txt', 'тоже не для него');

    check('ключ чужого вида не отдаётся, хотя он в хранилище есть',
      (await readPhoto('secrets/ключи.txt')) === null
      && (await env.PHOTOS.get('secrets/ключи.txt')) !== null);
    check('путь с «..» не отдаётся, хотя он в хранилище есть',
      (await readPhoto('objects/../побег.txt')) === null
      && (await env.PHOTOS.get('objects/../побег.txt')) !== null);

    // Распознавание форматов.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    check('PNG распознаётся', sniff(png)?.type === 'image/png');
    check('WebP распознаётся', sniff(webp)?.type === 'image/webp');
    check('текст картинкой не считается',
      sniff(new TextEncoder().encode('не картинка')) === null);

    // -----------------------------------------------------------------
    // Инвариант 7: журнал
    // -----------------------------------------------------------------
    const audit = await db.prepare(
      `select count(*) as n from audit_log where entity_type = 'objects' and entity_id = ?`,
    ).bind(obj.id).first<{ n: number }>();
    check('инв.7: правки объекта записаны в журнал', (audit?.n ?? 0) >= 5,
      `записей: ${audit?.n}`);

    // -----------------------------------------------------------------
    // Инвариант 3: комиссия
    // -----------------------------------------------------------------
    const total = commissionTotal('sale', 55_000_000);
    const shares = commissionShares(total);
    check('инв.3: продажа — 2% цены', total === 1_100_000, `вышло ${total}`);
    check('инв.3: доли складываются ровно в итог',
      (shares.listing ?? 0) + (shares.closing ?? 0) === total);

    // Комиссия партнёру названа мандатом процентом ОТ СДЕЛКИ, а не
    // долей нашей комиссии: «отдаю 1 % с продажи» — это и есть то, как
    // условие звучит на рынке.
    const price = 55_000_000;
    const onePercent = commissionShares(total, { priceMinor: price, rate: 1 });
    check('партнёру — названный процент от цены',
      onePercent.closing === 550_000, `вышло ${onePercent.closing}`);
    check('остальное ведущему агенту, и итог сходится',
      (onePercent.listing ?? 0) + (onePercent.closing ?? 0) === onePercent.total);

    const halfPercent = commissionShares(total, { priceMinor: price, rate: 0.5 });
    check('дробный процент считается, а не округляется до целого',
      halfPercent.closing === 275_000, `вышло ${halfPercent.closing}`);

    const none = commissionShares(total, { priceMinor: price, rate: 0 });
    check('ноль значит ноль, а не умолчание',
      none.closing === 0 && none.listing === total);

    // Обещано больше, чем берём сами: итогом становится обещанное, и у
    // ведущего агента ноль. Отрицательная доля прятала бы ошибку в
    // условиях за арифметикой.
    const tooMuch = commissionShares(total, { priceMinor: price, rate: 3 });
    check('обещанное сверх своей комиссии не даёт отрицательной доли',
      tooMuch.closing === 1_650_000 && tooMuch.listing === 0
      && tooMuch.total === 1_650_000,
      `${tooMuch.listing}/${tooMuch.closing}/${tooMuch.total}`);

    check('процент не назван — прежнее правило, пополам',
      commissionShares(total, { priceMinor: price, rate: null }).closing
        === commissionShares(total).closing);

    const odd = commissionTotal('rent', 30_001);
    const oddShares = commissionShares(odd);
    check('инв.3: нечётная сумма делится без потери',
      (oddShares.listing ?? 0) + (oddShares.closing ?? 0) === odd,
      `${oddShares.listing} + ${oddShares.closing} ≠ ${odd}`);

    // -----------------------------------------------------------------
    // Один человек — одна запись: телефон нормализуется
    // -----------------------------------------------------------------
    check('телефон: +996, 0700 и 700 дают один вид',
      normalizePhone('+996700112233') === normalizePhone('0700 11 22 33')
      && normalizePhone('0700 11 22 33') === normalizePhone('700112233'));

    const dup = await db.prepare(
      `insert into contact_phones (id, contact_id, phone, phone_normalized, is_primary, created_at)
       values (?, ?, ?, ?, 0, ?)`,
    ).bind(crypto.randomUUID(), owner?.contact_id ?? '', '+996 700 11 22 33',
           normalizePhone('+996700112233'), iso()).run().then(() => true).catch(() => false);
    check('один номер — один контакт: дубль отклонён схемой', dup === false);


    // --- Перенос каталога старого сайта -----------------------------------
    //
    // Главное здесь — ЧЕГО перенос не делает: не заводит объект из чужого
    // поискового запроса, не публикует и не переписывает то, что агент уже
    // правил. Выгрузка на 27 ноября 2026 года — 283 строки, из них 281
    // «Запрос».

    const csv = parseCsv(
      'id,title,description\n'
      + 'a,"Дом, с садом","строка\nвторая, с запятой и ""кавычками"""\n'
      + 'b,Квартира,\n',
    );
    check('CSV: поле с запятой и переводом строки прочитано целиком',
      csv.length === 2 && csv[0].title === 'Дом, с садом'
      && csv[0].description === 'строка\nвторая, с запятой и "кавычками"',
      JSON.stringify(csv[0]));

    const mapped = draftsFromCatalog([
      { id: 's1', deal: 'Аренда', status: 'опубликован', title: 'Дом', segment: 'Жильё',
        price: '150000 сом', per: '', rooms: '5', area: '156', floor: '1/1 этаж',
        district: 'Азия Молл', city: 'Бишкек', description: 'дом', actuality_at: '2026-11-12T12:36:58.772Z',
        photo_url: 'https://example.invalid/1.jpg' },
      { id: 's2', deal: 'Продажа', status: 'опубликован', title: 'Квартира', segment: 'Жильё',
        price: '145000 $', per: '', rooms: '2', area: '64', floor: '8/9 этаж',
        district: 'Бишкек', city: 'Бишкек', description: '', actuality_at: '' },
      { id: 's3', deal: 'Запрос', status: 'опубликован', title: 'Ищу комнату',
        price: '12000 сом', per: '/ мес', district: 'Джал', city: 'Бишкек' },
      { id: 's4', deal: 'Аренда', status: 'снят', title: 'Квартира', price: '500 $',
        per: '', district: 'Центр', city: 'Бишкек' },
      { id: 's5', deal: 'Аренда', status: 'опубликован', title: 'Квартира', price: '700 $',
        per: '/ м²/мес', district: 'Центр', city: 'Бишкек' },
      { id: 's6', deal: 'Аренда', status: 'опубликован', title: 'Яхта', price: '700 $',
        per: '', district: 'Центр', city: 'Бишкек' },
    ] as never);

    check('перенос: запрос объектом не становится',
      !mapped.drafts.some((d) => d.id === 's3')
      && mapped.skipped.some((s) => s.id === 's3' && s.why === 'не объявление, а запрос'));
    check('перенос: снятое с публикации не переносится',
      !mapped.drafts.some((d) => d.id === 's4'));
    check('перенос: цена за метр не кладётся туда, где цена за объект',
      !mapped.drafts.some((d) => d.id === 's5'));
    check('перенос: неизвестный вид жилья не угадывается',
      !mapped.drafts.some((d) => d.id === 's6'));

    const s1 = mapped.drafts.find((d) => d.id === 's1');
    const s2 = mapped.drafts.find((d) => d.id === 's2');
    check('перенос: сом и доллар разложены в минорные единицы',
      s1?.price_minor === 15000000 && s1?.currency === 'KGS'
      && s2?.price_minor === 14500000 && s2?.currency === 'USD',
      JSON.stringify([s1?.price_minor, s1?.currency, s2?.price_minor, s2?.currency]));
    check('перенос: «8/9 этаж» — восьмой из девяти',
      s2?.floor === 8 && s2?.floors_total === 9);
    check('перенос: адрес собран из вида и района',
      s1?.address === 'Дом, Азия Молл' && s1?.zone === 'Азия Молл', s1?.address);

    // Теперь то же самое, но через настоящую базу снимка.
    const snapshotCsv = [
      'id,segment,deal,title,price,per,rooms,area,floor,district,city,status,description,actuality_at,photo_url',
      'site-1,Жильё,Аренда,Дом,150000 сом,,5,156,1/1 этаж,Азия Молл,Бишкек,опубликован,дом у парка,2026-11-12T12:36:58.772Z,https://example.invalid/1.jpg',
      'site-2,Жильё,Запрос,Ищу комнату,12000 сом,/ мес,1,,3,Джал,Бишкек,опубликован,ищу комнату,,',
    ].join('\n');

    await env.CATALOG.prepare(
      `insert or replace into public_catalog_snapshot
         (singleton, generated_at_ms, content_type, body, sha256, row_count)
       values (1, ?, 'text/csv', ?, '', 2)`,
    ).bind(Date.now(), snapshotCsv).run();

    // Хозяин черновиков — старший одобренный администратор. Проверяем
    // именно правило, а не заранее известный идентификатор: к этому месту
    // набора администраторы уже заведены предыдущими проверками.
    const chief = (await db.prepare(
      `select id from agents where role = 'admin' and status = 'approved'
        order by created_at limit 1`,
    ).first<{ id: string }>())?.id;

    const first = await importCatalog();
    check('перенос: из двух строк заведена одна — объявление, не запрос',
      first.imported === 1 && first.rows === 2 && first.skipped === 1,
      JSON.stringify({ imported: first.imported, rows: first.rows, skipped: first.skipped }));

    const landed = await db.prepare(
      'select id, publication_state, source, created_by_agent_id, price_minor, currency, zone from objects where id = ?',
    ).bind('site-1').first<{ publication_state: string; source: string; created_by_agent_id: string;
      price_minor: number; currency: string; zone: string }>();
    check('перенос: карточка приехала черновиком, с отметкой источника и хозяином',
      landed?.publication_state === 'draft' && landed?.source === IMPORT_SOURCE
      && landed?.created_by_agent_id === chief && landed?.price_minor === 15000000
      && landed?.currency === 'KGS' && landed?.zone === 'Азия Молл',
      JSON.stringify(landed));

    const rerun = await importCatalog();
    check('перенос идемпотентен: второй прогон дубликатов не плодит',
      rerun.imported === 0 && rerun.already === 1,
      JSON.stringify({ imported: rerun.imported, already: rerun.already }));

    // Агент поправил адрес и опубликовал — ночной прогон не вправе это
    // затереть. Проверяем не «не изменилось», а именно работу агента.
    await db.prepare(
      `update objects set address = ?, publication_state = 'published', updated_at = ?
        where id = ?`,
    ).bind('Чүй 120, кв. 5', iso(), 'site-1').run();
    await importCatalog();
    const afterEdit = await db.prepare(
      'select address, publication_state from objects where id = ?',
    ).bind('site-1').first<{ address: string; publication_state: string }>();
    check('перенос не трогает то, что агент уже правил',
      afterEdit?.address === 'Чүй 120, кв. 5' && afterEdit?.publication_state === 'published',
      JSON.stringify(afterEdit));


    // -----------------------------------------------------------------
    // Заявка собственника: другая сторона рынка в той же форме
    // -----------------------------------------------------------------
    {
      await loginAs(db, anna);

      // Адрес, присланный со стороны поиска, в заявку попасть не должен:
      // поля формы видны всем, и чужое поле не делает заявку чужой.
      const findId = await submitRequest({
        phone: '0555 10 20 30', deal: 'rent', district: 'Асанбай',
        address: 'Эркиндик 1', consent: true,
      });
      const find = await db.prepare(
        'select deal, offer_deal, address from requests where id = ?',
      ).bind(findId).first<{ deal: string | null; offer_deal: string | null; address: string | null }>();
      check('заявка на поиск остаётся поиском: ни стороны, ни адреса',
        find?.deal === 'rent' && find?.offer_deal === null && find?.address === null,
        JSON.stringify(find));

      const ownId = await submitRequest({
        phone: '0555 10 20 31', offer_deal: 'sale', deal: 'buy',
        address: 'Эркиндик 64б, кв. 12', budget_minor: 8_000_000,
        name: 'Нурлан', consent: true,
      });
      const own = await db.prepare(
        'select deal, offer_deal, address, budget_minor from requests where id = ?',
      ).bind(ownId).first<{ deal: string | null; offer_deal: string | null; address: string | null }>();
      // Направление поиска снимается: «продаю» и «ищу купить» в одной
      // строке читались бы по-разному в разных местах кабинета.
      check('заявка собственника: сторона записана, направление поиска снято',
        own?.offer_deal === 'sale' && own?.deal === null
          && own?.address === 'Эркиндик 64б, кв. 12',
        JSON.stringify(own));

      const offers = await requestFeed('offers');
      check('вкладка «от собственников» показывает только их',
        offers.rows.some((r) => r.id === ownId)
          && !offers.rows.some((r) => r.id === findId));

      const open = await requestFeed('open');
      check('заявка собственника не выпадает из общей ленты свободных',
        open.rows.some((r) => r.id === ownId));

      const counts = await requestCounts();
      check('заявки собственников считаются отдельным числом',
        counts.offers >= 1 && counts.free >= 2,
        JSON.stringify(counts));

      // Чужое значение стороны не роняет заявку: потерять её из-за кривого
      // поля хуже, чем принять как обычный поиск.
      const oddId = await submitRequest({ phone: '0555 10 20 32', offer_deal: 'подарю' });
      const odd = await db.prepare('select offer_deal from requests where id = ?')
        .bind(oddId).first<{ offer_deal: string | null }>();
      check('неизвестная сторона не роняет заявку, а просто не пишется',
        odd?.offer_deal === null, JSON.stringify(odd));
    }
    // Индекс рынка: разбор чужой страницы и запись наблюдений
    // -----------------------------------------------------------------
    //
    // Разбор проверяется на СНИМКЕ НАСТОЯЩЕЙ СТРАНИЦЫ house.kg, а не на
    // выдуманной разметке: парсер чужого сайта, проверенный на HTML,
    // который мы сами сочинили, проверяет только нашу фантазию.

    const housePage = parseSearchPage(houseKgPage, 'sale');

    check('разбор снимка берёт все карточки и ничего не теряет',
      housePage.cards.length === 3 && Object.keys(housePage.skipped).length === 0,
      `карточек ${housePage.cards.length}, отброшено ${JSON.stringify(housePage.skipped)}`);

    const houseFlat = housePage.cards[0];
    check('цена берётся, а не платёж по ипотеке',
      houseFlat.priceUsd === 270000 && houseFlat.priceKgs === 23652000,
      `${houseFlat.priceUsd} $ / ${houseFlat.priceKgs} сом`);

    check('заголовок разобран: комнаты, площадь, этаж из скольких',
      houseFlat.rooms === 2 && houseFlat.area === 92 && houseFlat.floor === 5 && houseFlat.floorsTotal === 10,
      JSON.stringify(houseFlat));

    // Та самая карточка, на которой разбор падал молча: цифра из номера
    // дома «Токомбаева 21/6» приклеивалась к цене.
    const houseGlued = housePage.cards[2];
    check('цифра из номера дома не приклеивается к цене',
      houseGlued.priceKgs === 25935000 && houseGlued.priceUsd === 296062,
      `${houseGlued.priceUsd} $ / ${houseGlued.priceKgs} сом`);

    check('повторённый город из адреса убран',
      houseGlued.address === 'Токомбаева 21/6', String(houseGlued.address));

    // Главная проверка о продавце. У этой карточки есть И бейдж
    // «Собственник», И подпись «От Avangard style». Поверить бейджу
    // значит набить список для обзвона агентствами.
    check('бейдж «Собственник» не перевешивает подпись агентства',
      houseGlued.sellerKind === 'agency' && houseGlued.sellerName === 'Avangard style',
      `${houseGlued.sellerKind} / ${houseGlued.sellerName}`);

    check('собственник без подписи агентства остаётся собственником',
      houseFlat.sellerKind === 'owner' && houseFlat.sellerName === null,
      `${houseFlat.sellerKind} / ${houseFlat.sellerName}`);

    check('сигналы актуальности сняты',
      houseFlat.views === 196 && houseFlat.favorites === 13 && houseFlat.bumped === true
      && houseFlat.marketNote === 'Выше рынка на 74.27%',
      JSON.stringify({ v: houseFlat.views, f: houseFlat.favorites, b: houseFlat.bumped }));

    // Возраст объявления словами. «Позавчера» содержит «вчера» внутри
    // себя — на этом разбор уже ошибался на целые сутки.
    const marketBase = Date.UTC(2026, 10, 27, 12, 0, 0);
    const hoursBack = (label: string) => {
      const at = bumpedAt(label, marketBase);
      return at === null ? null : Math.round((marketBase - Date.parse(at)) / 3600_000);
    };
    check('«4 часа назад» это четыре часа', hoursBack('4 часа назад') === 4,
      String(hoursBack('4 часа назад')));
    check('«позавчера» это двое суток, а не одни',
      hoursBack('позавчера') === 48, String(hoursBack('позавчера')));
    check('единица без числа читается как одна: «месяц назад»',
      hoursBack('месяц назад') === 720, String(hoursBack('месяц назад')));
    check('непонятный возраст не выдаётся за свежесть',
      bumpedAt('в прошлом веке', marketBase) === null);

    check('первая страница раздела идёт без номера',
      searchUrl('kupit-kvartiru', 2) === 'https://www.house.kg/kupit-kvartiru?town=2'
      && searchUrl('kupit-kvartiru', 2, 3) === 'https://www.house.kg/kupit-kvartiru?town=2&page=3');

    check('подпись агентства без бейджа — это агентство',
      sellerOf('<div>От Этажи</div>').kind === 'agency');
    check('ни бейджа, ни подписи — честное «неизвестно»',
      sellerOf('<div>просто текст</div>').kind === 'unknown');


    // --- аренда: одна валюта, обязательный срок, две вёрстки -----------
    //
    // Снимок аренды нужен отдельно от снимка продажи: там другая цена
    // (одна валюта со сроком), там есть посуточные объявления, и там
    // каждое объявление нарисовано ДВУМЯ карточками. На снимке продажи
    // ничего этого не видно, и разбор аренды был сломан, пока его не
    // прогнали по живой странице.

    const rentPage = parseSearchPage(houseKgRent, 'rent');

    check('две вёрстки одного объявления — это одно объявление',
      rentPage.cards.length === 2 && Object.keys(rentPage.skipped).length === 0,
      `объявлений ${rentPage.cards.length}, отброшено ${JSON.stringify(rentPage.skipped)}`);

    const monthly = rentPage.cards.find((c) => c.period === 'month');
    const daily = rentPage.cards.find((c) => c.period === 'day');

    check('месячная аренда берётся в сомах и со сроком',
      monthly?.priceKgs === 63000 && monthly?.priceUsd === null,
      JSON.stringify({ kgs: monthly?.priceKgs, usd: monthly?.priceUsd }));

    check('характеристики читаются и из сжатой карточки',
      monthly?.rooms === 3 && monthly?.area === 60 && monthly?.floorsTotal === 4,
      JSON.stringify(monthly));

    // Посуточная аренда — другой рынок. 3 800 в сутки и 63 000 в месяц
    // стоят в одной выдаче рядом; сложив их в одну медиану, получим
    // число, которого на рынке нет.
    check('посуточная аренда отличается от месячной',
      daily?.period === 'day' && daily?.priceKgs === 3800,
      JSON.stringify({ period: daily?.period, kgs: daily?.priceKgs }));

    // Счётчик фотографий стоит в карточке прямо перед ценой. В сплошном
    // тексте «30 306 250» выглядит правильно сгруппированным числом, и
    // цена аренды дома однажды уехала в тридцать раз. Разбор идёт по
    // узлам разметки: счётчик лежит в своём узле, цена в своём.
    check('счётчик фотографий не приклеивается к цене',
      JSON.stringify(parsePrices(
        '<div><span>30</span><span>306 250 ⃀</span><span>3 496 $</span></div>', 'rent',
      )) === JSON.stringify({ usd: 3496, kgs: 306250, period: 'month' }),
      JSON.stringify(parsePrices(
        '<div><span>30</span><span>306 250 ⃀</span><span>3 496 $</span></div>', 'rent')));

    check('пара валют без срока считается месячной',
      parsePrices('<div><span>306 250 ⃀</span><span>3 496 $</span></div>', 'rent')?.period
        === 'month');

    check('сказано про сутки, а срок не распознан — объявление не берётся',
      parsePrices('<div><span>посуточно</span><span>306 250 ⃀</span><span>3 496 $</span></div>',
        'rent') === null);

    check('аренда без срока не берётся вовсе',
      parsePrices('<div>63 000 ⃀</div>', 'rent') === null);

    // Платёж по ипотеке в карточке продажи назван «в мес». У цены
    // продажи срока не бывает, поэтому числа со сроком здесь не
    // рассматриваются вовсе — это вторая преграда после проверки курса.
    check('одинокое число со сроком не становится ценой продажи',
      parsePrices('<div>167 514 сом в мес</div>', 'sale') === null);

    check('участок: сотки переводятся в метры, а не идут как есть',
      specsOf('<div>участок, 8 соток</div>').area === 800,
      String(specsOf('<div>участок, 8 соток</div>').area));

    // --- запись наблюдений -------------------------------------------

    const marketSaved = await saveCards('sale', 'flat', 'Бишкек', housePage.cards, () => null);
    check('наблюдения заводятся', marketSaved.added === 3 && marketSaved.updated === 0,
      JSON.stringify(marketSaved));

    const priceRows = async () => (await db.prepare(
      'select count(*) as n from market_prices').first<{ n: number }>())?.n ?? -1;
    check('у каждого наблюдения записана первая цена', await priceRows() === 3,
      String(await priceRows()));

    // Повторный прогон теми же данными не заводит второй копии и не
    // пишет в историю ни строки: иначе за год на каждое объявление
    // накопилось бы 365 одинаковых записей.
    const marketSecond = await saveCards('sale', 'flat', 'Бишкек', housePage.cards, () => null);
    check('повторный прогон не задваивает объявление',
      marketSecond.added === 0 && marketSecond.updated === 3, JSON.stringify(marketSecond));
    check('цена, которая не менялась, в историю не пишется',
      marketSecond.priceChanged === 0 && await priceRows() === 3, String(await priceRows()));

    const firstSeen = await db.prepare(
      'select first_seen_at, last_seen_at from market_listings where source_id = ?',
    ).bind(housePage.cards[0].sourceId).first<{ first_seen_at: string; last_seen_at: string }>();

    // Подешевевшие объявления: ровно тот сигнал, ради которого история и
    // заведена.
    const cheaper = housePage.cards.map((c) => ({
      ...c,
      priceUsd: (c.priceUsd ?? 0) - 1000,
      priceKgs: (c.priceKgs ?? 0) - 87000,
    }));
    const marketThird = await saveCards('sale', 'flat', 'Бишкек', cheaper, () => null);
    check('снижение цены попадает в историю',
      marketThird.priceChanged === 3 && await priceRows() === 6,
      `${marketThird.priceChanged} изменений, строк ${await priceRows()}`);

    const marketAfter = await db.prepare(
      'select first_seen_at, price_usd_minor from market_listings where source_id = ?',
    ).bind(housePage.cards[0].sourceId).first<{ first_seen_at: string; price_usd_minor: number }>();
    check('дата первой встречи не переписывается',
      marketAfter?.first_seen_at === firstSeen?.first_seen_at,
      `${firstSeen?.first_seen_at} → ${marketAfter?.first_seen_at}`);
    check('новая цена встала на место прежней',
      marketAfter?.price_usd_minor === ((housePage.cards[0].priceUsd ?? 0) - 1000) * 100,
      String(marketAfter?.price_usd_minor));

    // Исчезнувшие. Помечаются, а не удаляются: проданное по известной
    // цене говорит о рынке честнее, чем висящее.
    const marketFuture = new Date(Date.now() + 60_000).toISOString();
    const goneCount = await markGone('sale', 'flat', 'Бишкек', marketFuture);
    check('пропавшие из выдачи помечаются', goneCount === 3, String(goneCount));

    const sizeGone = await marketSize();
    check('помеченные не считаются живыми',
      sizeGone.live === 0 && sizeGone.gone === 3, JSON.stringify(sizeGone));

    // Объявление вернулось в выдачу — пометка снимается сама.
    await saveCards('sale', 'flat', 'Бишкек', housePage.cards, () => null);
    const sizeBack = await marketSize();
    check('вернувшееся объявление снова живое',
      sizeBack.live === 3 && sizeBack.gone === 0, JSON.stringify(sizeBack));


    // -----------------------------------------------------------------
    // Оценка по сопоставимым
    // -----------------------------------------------------------------

    const comp = (priceMinor: number, area: number, rooms = 2): Comparable => ({
      id: crypto.randomUUID(), url: 'https://www.house.kg/details/x',
      priceMinor, area, rooms, address: null, sellerKind: 'unknown', bumpedAt: null,
    });

    check('медиана берёт середину, а не среднее',
      median([1, 2, 3, 4, 100]) === 3, String(median([1, 2, 3, 4, 100])));
    check('квантиль считается с интерполяцией',
      quantile([10, 20, 30, 40], 0.5) === 25, String(quantile([10, 20, 30, 40], 0.5)));

    // На четырёх объявлениях медиана — среднее двух средних, и одно
    // кривое двигает её заметно. Поэтому ниже пяти — отказ.
    check('на четырёх похожих оценки не бывает',
      valuate([comp(100, 1), comp(110, 1), comp(120, 1), comp(130, 1)], 50, 'точно') === null);

    const even = valuate(
      [comp(1000_00, 50), comp(1100_00, 50), comp(1200_00, 50),
       comp(1300_00, 50), comp(1400_00, 50)], 50, 'точно',
    );
    check('вилка это четверть и три четверти рынка, а не «плюс-минус»',
      even?.lowMinor === 1100_00 && even?.midMinor === 1200_00 && even?.highMinor === 1300_00,
      JSON.stringify({ l: even?.lowMinor, m: even?.midMinor, h: even?.highMinor }));

    // Главное, ради чего медиана. В индексе лежит НАСТОЯЩЕЕ объявление
    // «комната 20 м² за 2 002 810 $»: так написал продавец, курс там
    // сходится, то есть разбор не ошибся. Среднее от такой строки уезжает
    // в разы.
    const withJunk = valuate(
      [comp(1000_00, 50), comp(1100_00, 50), comp(1200_00, 50),
       comp(1300_00, 50), comp(1400_00, 50), comp(2_002_810_00, 50)], 50, 'точно',
    );
    check('объявление с безумной ценой не двигает оценку',
      withJunk !== null && withJunk.midMinor === 1250_00,
      String(withJunk?.midMinor));

    check('отклонение от рынка считается от середины выборки',
      even !== null && awayFromMarket(1500_00, even) === 25,
      String(even === null ? 'нет оценки' : awayFromMarket(1500_00, even)));

    // Курс берётся из самих объявлений: ключей к курсовым службам нет, а
    // вписанное в код число молча устаревает.
    const ratePairs = (n: number, rate: number) =>
      Array.from({ length: n }, () => ({ usdMinor: 100_00, kgsMinor: Math.round(100_00 * rate) }));
    check('на девяти парах курс не считается — это случайность, а не курс',
      rateFromPairs(ratePairs(9, 87)) === null);
    check('на десяти считается', rateFromPairs(ratePairs(10, 87)) === 87,
      String(rateFromPairs(ratePairs(10, 87))));
    check('пары с невозможным курсом в расчёт не идут',
      rateFromPairs([...ratePairs(10, 87), { usdMinor: 100_00, kgsMinor: 100 }]) === 87);

    // --- оценка по настоящей базе ------------------------------------

    const seedMarket = async (
      n: number, deal: string, kind: string, city: string,
      usd: number | null, kgs: number | null, area: number, rooms: number,
      address: string, period: string | null, seenAt: string,
    ) => {
      for (let i = 0; i < n; i++) {
        await db.prepare(
          `insert into market_listings
             (id, source, source_id, url, deal_type, kind, city, address, rooms, area,
              price_usd_minor, price_kgs_minor, rent_period, search_text,
              first_seen_at, last_seen_at)
           values (?, 'house.kg', ?, 'https://www.house.kg/details/s', ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), crypto.randomUUID(), deal, kind, city, address, rooms, area,
          usd === null ? null : (usd + i * 100) * 100,
          kgs === null ? null : (kgs + i * 8700) * 100,
          period, address.toLowerCase(), seenAt, seenAt,
        ).run();
      }
    };

    // Шесть двушек в Асанбае и шесть в другом районе, дороже.
    await seedMarket(6, 'sale', 'flat', 'Ош', 50000, 4350000, 60, 2, 'Асанбай 1', null, iso());
    await seedMarket(6, 'sale', 'flat', 'Ош', 90000, 7830000, 60, 2, 'Джал 5', null, iso());

    const inZone = await estimate({
      deal: 'sale', kind: 'flat', city: 'Ош', zone: 'Асанбай',
      rooms: 2, area: 60, currency: 'USD', period: null,
    });
    check('оценка по своему району берёт только свой район',
      inZone.valuation?.basis.widening === 'точно' && inZone.valuation?.basis.count === 6,
      JSON.stringify(inZone.valuation?.basis));
    check('оценка по району не утягивается соседним, который дороже',
      inZone.valuation !== null && inZone.valuation.midMinor < 60_000_00,
      String(inZone.valuation?.midMinor));

    // Район, которого в индексе нет: лестница обязана шагнуть шире и
    // СКАЗАТЬ об этом, а не молча посчитать по всему городу.
    const noZone = await estimate({
      deal: 'sale', kind: 'flat', city: 'Ош', zone: 'Кызыл-Аскер',
      rooms: 2, area: 60, currency: 'USD', period: null,
    });
    check('нет района — выборка расширяется и это названо',
      noZone.valuation?.basis.widening === 'без района'
      && noZone.valuation?.basis.count === 12,
      JSON.stringify(noZone.valuation?.basis));

    // Посуточная аренда не должна попадать в месячную оценку.
    await seedMarket(6, 'rent', 'flat', 'Ош', null, 60000, 50, 2, 'Асанбай 1', 'month', iso());
    await seedMarket(6, 'rent', 'flat', 'Ош', null, 3000, 50, 2, 'Асанбай 1', 'day', iso());

    const rentMonthly = await estimate({
      deal: 'rent', kind: 'flat', city: 'Ош', zone: null,
      rooms: 2, area: 50, currency: 'KGS', period: 'month',
    });
    check('посуточная аренда в месячную оценку не попадает',
      rentMonthly.valuation?.basis.count === 6
      && rentMonthly.valuation !== null && rentMonthly.valuation.midMinor > 50_000_00,
      JSON.stringify({ n: rentMonthly.valuation?.basis.count, mid: rentMonthly.valuation?.midMinor }));

    // Аренда лежит только в сомах, а спросили в долларах: приведение
    // идёт по курсу, посчитанному из объявлений продажи.
    const rate = await observedRate();
    check('курс посчитан по самим объявлениям', rate !== null && rate > 60 && rate < 130,
      String(rate));

    const estimateInUsd = await estimate({
      deal: 'rent', kind: 'flat', city: 'Ош', zone: null,
      rooms: 2, area: 50, currency: 'USD', period: 'month',
    });
    check('цену в сомах приводят к доллару по этому курсу',
      estimateInUsd.valuation !== null && rate !== null
      && Math.abs(estimateInUsd.valuation.midMinor - (rentMonthly.valuation?.midMinor ?? 0) / rate) < 100,
      JSON.stringify({ usd: estimateInUsd.valuation?.midMinor, kgs: rentMonthly.valuation?.midMinor }));

    // Протухшие объявления в оценку не идут.
    const longAgo = new Date(Date.now() - 400 * 24 * 3600_000).toISOString();
    await seedMarket(8, 'sale', 'house', 'Ош', 30000, 2610000, 100, 4, 'Старьё', null, longAgo);
    const staleValue = await estimate({
      deal: 'sale', kind: 'house', city: 'Ош', zone: null,
      rooms: 4, area: 100, currency: 'USD', period: null,
    });
    check('позапрошлогодние объявления в оценку не идут',
      staleValue.valuation === null && staleValue.reason === 'индекс пуст',
      JSON.stringify({ r: staleValue.reason, pool: staleValue.pool }));

    // Три участка в индексе есть, а оценки нет: три — это не выборка.
    // Отказ при этом РАЗНЫЙ по причине, и это важно: «индекс пуст»
    // чинится обходом, «мало похожих» не чинится ничем.
    await seedMarket(3, 'sale', 'land', 'Ош', 20000, 1740000, 500, 0, 'Поле', null, iso());
    const fewLand = await estimate({
      deal: 'sale', kind: 'land', city: 'Ош', zone: null,
      rooms: null, area: 500, currency: 'USD', period: null,
    });
    check('три объявления — это отказ, а не оценка',
      fewLand.valuation === null && fewLand.reason === 'мало похожих' && fewLand.pool === 3,
      JSON.stringify({ r: fewLand.reason, pool: fewLand.pool }));

    // Город, которого в индексе нет вовсе. Типы здесь ограничены теми,
    // которые обход умеет брать: оценивать гараж нечем, и это запрещено
    // типом, а не проверкой во время работы.
    const emptySegment = await estimate({
      deal: 'sale', kind: 'flat', city: 'Нарын', zone: null,
      rooms: 2, area: 60, currency: 'USD', period: null,
    });
    check('пустой сегмент отличается от «мало похожих»',
      emptySegment.reason === 'индекс пуст', String(emptySegment.reason));


    // -----------------------------------------------------------------
    // Проверка своего объекта по площадке
    // -----------------------------------------------------------------
    //
    // Ради этого и собирался индекс. «Проверен» — обещание, и проверяемо
    // оно здесь: объект, который уже висит на площадке под другой ценой,
    // виден агенту до того, как карточка уйдёт в работу.

    check('«Чуй» не теряется из-за длины слова',
      addressOverlap('Чуй 120', 'ул. Чүй 120/1').words.join() === 'чуй',
      JSON.stringify(addressOverlap('Чуй 120', 'ул. Чүй 120/1')));

    check('служебные слова совпадением не считаются',
      addressOverlap('ул. Советская 5, дом', 'улица Ахунбаева 7, дом').words.length === 0,
      JSON.stringify(addressOverlap('ул. Советская 5, дом', 'улица Ахунбаева 7, дом')));

    // В Бишкеке половина адресов — микрорайоны, и они записаны числами.
    // Без отдельного признака такой адрес распадался на цифры и не
    // сличался никогда.
    check('микрорайон — это признак места, а не номер дома',
      addressOverlap('12 мкр 57/1', 'мкр 12, д. 57/1').words.join() === 'мкр-12',
      JSON.stringify(addressOverlap('12 мкр 57/1', 'мкр 12, д. 57/1')));
    check('разные микрорайоны не совпадают',
      addressOverlap('12 мкр 57', '6 мкр 57').words.length === 0);

    const ourFlat = {
      address: 'Чуй 120', zone: 'Центр', rooms: 2, area: 60, floor: 5,
      price: 80000, currency: 'USD',
    };
    const theirs = (over: Partial<Parameters<typeof resemble>[1]> = {}) => ({
      id: 'x', url: 'https://www.house.kg/details/x', address: 'ул. Чүй 120/1',
      rooms: 2, area: 60, floor: 5, priceUsd: 90000, priceKgs: null,
      sellerKind: 'agency' as const, sellerName: 'Этажи', bumpedAt: null, ...over,
    });

    check('совпали улица и площадь — объявление показывается',
      resemble(ourFlat, theirs(), null) !== null);

    // Одной похожей площади мало: в доме таких квартир десяток.
    check('одна лишь похожая площадь совпадением не считается',
      resemble(ourFlat, theirs({ address: 'Ахунбаева 7' }), null) === null);

    const found = resemble(ourFlat, theirs(), null);
    check('расхождение в цене названо числом и процентом',
      found?.differences.some((d) => d.what === 'цена' && d.theirs.includes('+13%')) === true,
      JSON.stringify(found?.differences));

    check('кто подаёт объявление — всегда в расхождениях',
      found?.differences.some((d) => d.what === 'подаёт' && d.theirs.includes('Этажи')) === true);

    const areaOff = resemble(ourFlat, theirs({ area: 72 }), null);
    check('расхождение в площади названо',
      areaOff?.differences.some((d) => d.what === 'площадь') === true,
      JSON.stringify(areaOff?.differences));

    // Сортировка: сперва то, где признаков больше. Агент смотрит первое.
    const ranked = resembleAll(ourFlat, [
      theirs({ id: 'слабое', address: 'Чуй 200', area: 60.5 }),
      theirs({ id: 'сильное' }),
    ], null);
    check('первым показывается то, где признаков больше',
      ranked[0]?.candidate.id === 'сильное',
      ranked.map((r) => `${r.candidate.id}:${r.signals.length}`).join(' '));

    // --- по настоящей базе -------------------------------------------

    await db.prepare(
      `insert into market_listings
         (id, source, source_id, url, deal_type, kind, city, address, rooms, area, floor,
          price_usd_minor, price_kgs_minor, seller_kind, seller_name, search_text,
          first_seen_at, last_seen_at)
       values (?, 'house.kg', ?, 'https://www.house.kg/details/dup', 'sale', 'flat',
               'Бишкек', 'ул. Чүй 120/1', 2, 60, 5, ?, null, 'owner', null, 'чуй', ?, ?)`,
    ).bind(crypto.randomUUID(), crypto.randomUUID(), 90000_00, iso(), iso()).run();

    const lookalike = await marketLookalikes({
      kind: 'flat', deal_type: 'sale', city: 'Бишкек', address: 'Чуй 120',
      zone: null, rooms: 2, area: 60, floor: 5, price: 80000, currency: 'USD',
    });
    check('свой объект находится среди объявлений площадки',
      lookalike.comparable && lookalike.found.length === 1,
      JSON.stringify({ c: lookalike.comparable, n: lookalike.found.length }));

    // Типы, которых обход не берёт, сравнивать не с чем — и об этом
    // надо сказать, а не показывать «ничего не нашлось».
    const noCompare = await marketLookalikes({
      kind: 'garage', deal_type: 'sale', city: 'Бишкек', address: 'Чуй 120',
      zone: null, rooms: null, area: 20, floor: null, price: 10000, currency: 'USD',
    });
    check('«сравнивать не с чем» отличается от «не нашлось»',
      noCompare.comparable === false && noCompare.found.length === 0);


    // -----------------------------------------------------------------
    // Поиск собственников
    // -----------------------------------------------------------------

    // Дата публикации берётся со страницы объявления: в выдаче написано,
    // когда объявление ПОДНЯЛИ, а не когда подали. Поднятое сегодня
    // может висеть с весны — и именно такой продавец устал продавать сам.
    const listingHtml = '<script type="application/ld+json">'
      + '{"@context":"https://schema.org","@type":"RealEstateListing",'
      + '"datePosted":"2026-11-11T11:36:17",'
      + '"about":{"geo":{"latitude":42.8251,"longitude":74.5832}}}</script>';
    const parsedPage = parseListingPage(listingHtml);
    check('дата публикации читается со страницы объявления',
      parsedPage.postedAt === '2026-11-11T05:36:17.000Z',
      String(parsedPage.postedAt));
    check('координаты оттуда же',
      parsedPage.latitude === 42.8251 && parsedPage.longitude === 74.5832);
    check('страница без разметки не выдумывает дату',
      parseListingPage('<html>пусто</html>').postedAt === null);

    const ownerRow = (over: Partial<OwnerRow> = {}): OwnerRow => ({
      id: crypto.randomUUID(), url: 'https://www.house.kg/details/o',
      address: 'Чуй 120', rooms: 2, area: 60, priceUsd: 80000, priceKgs: null,
      postedAt: null, firstSeenAt: new Date().toISOString(), bumped: false,
      drops: 0, dropPercent: 0, ...over,
    });

    const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
    const longAgoIso = new Date(nowMs - 200 * 24 * 3600_000).toISOString();

    // Свежее объявление без снижения — обычный продавец, полный надежд.
    // Звонить ему не за чем, и в списке его быть не должно.
    check('свежее объявление без признаков в список не идёт',
      rank([ownerRow({ firstSeenAt: new Date(nowMs).toISOString() })], nowMs).length === 0);

    const ownerOld = rank([ownerRow({ postedAt: longAgoIso })], nowMs)[0];
    check('давний срок — признак, и он назван словами',
      ownerOld?.signals.some((x) => x.text.includes('полугода')) === true,
      JSON.stringify(ownerOld?.signals));
    check('срок считается от публикации, а не от нашего обхода',
      ownerOld?.daysFrom === 'публикация' && ownerOld?.days === 200,
      JSON.stringify({ from: ownerOld?.daysFrom, days: ownerOld?.days }));

    // Своей даты нет — считаем от первой встречи, НО говорим об этом:
    // настоящий срок может быть больше.
    const seenOnly = rank([ownerRow({ firstSeenAt: longAgoIso })], nowMs)[0];
    check('без своей даты срок считается от обхода и это названо',
      seenOnly?.daysFrom === 'наш обход' && seenOnly?.days === 200,
      JSON.stringify({ from: seenOnly?.daysFrom, days: seenOnly?.days }));

    const ownerDropped = rank([ownerRow({ drops: 2, dropPercent: 12 })], nowMs)[0];
    check('снижение цены названо числом и количеством раз',
      ownerDropped?.signals[0]?.text.includes('снижалась 2 раза, всего на 12%') === true,
      JSON.stringify(ownerDropped?.signals));

    // Уступка в 40% чаще означает, что объявление начиналось с фантазии,
    // а не что продавец сговорчив. Поэтому вес ограничен.
    const ownerHuge = rank([ownerRow({ drops: 1, dropPercent: 60 })], nowMs)[0];
    const ownerModest = rank([ownerRow({ drops: 1, dropPercent: 20 })], nowMs)[0];
    check('огромная уступка не перевешивает всё остальное',
      ownerHuge?.score === ownerModest?.score,
      JSON.stringify({ ownerHuge: ownerHuge?.score, ownerModest: ownerModest?.score }));

    const ownerOrder = rank([
      ownerRow({ id: 'слабый', bumped: true }),
      ownerRow({ id: 'сильный', postedAt: longAgoIso, drops: 1, dropPercent: 10, bumped: true }),
    ], nowMs);
    check('сверху тот, у кого признаков больше',
      ownerOrder[0]?.row.id === 'сильный',
      ownerOrder.map((l) => `${l.row.id}:${l.score}`).join(' '));

    // Черновик письма собирается ИЗ ФАКТОВ. Выдуманная в нём деталь —
    // «вижу, вы давно продаёте» про объявление недельной давности —
    // стоит сделки и репутации.
    const letterOld = invitation(ownerOld!, 'Liberterra', 'Анна');
    check('в письме стоит настоящий срок',
      letterOld.includes('200 дн. назад') && letterOld.includes('Анна'),
      letterOld.slice(0, 120));

    const ownerFresh = rank([ownerRow({ drops: 1, dropPercent: 5 })], nowMs)[0];
    const letterFresh = invitation(ownerFresh!, 'Liberterra', 'Анна');

    // Черновик не навязывает агенту род: половина агентов — женщины, и
    // «увидел» в письме за подписью Анны читается как чужой текст.
    check('в черновике нет глаголов, навязывающих род',
      !letterOld.includes('Увидел') && !letterOld.includes('Вижу'),
      letterOld.slice(0, 140));
    check('свежему объявлению не приписывается долгий срок',
      !letterFresh.includes('дн. назад') && letterFresh.includes('Цену вы уже снижали'),
      letterFresh.slice(0, 160));

    // --- по настоящей базе -------------------------------------------

    const seedOwner = async (sourceId: string, seller: string, posted: string | null) => {
      const oid = crypto.randomUUID();
      await db.prepare(
        `insert into market_listings
           (id, source, source_id, url, deal_type, kind, city, address, rooms, area,
            price_usd_minor, price_kgs_minor, seller_kind, search_text, posted_at,
            first_seen_at, last_seen_at)
         values (?, 'house.kg', ?, 'https://www.house.kg/details/' || ?, 'sale', 'flat',
                 'Каракол', 'Гагарина 7', 2, 60, ?, null, ?, 'гагарина', ?, ?, ?)`,
      ).bind(oid, sourceId, sourceId, 50000_00, seller, posted, longAgoIso, iso()).run();
      return oid;
    };

    const ownerId = await seedOwner('own-1', 'owner', null);
    await seedOwner('ag-1', 'agency', null);

    const queue = await ownersWithoutDate(10);
    check('в очередь за датой идут только собственники',
      queue.some((q) => q.id === ownerId) && queue.length >= 1
      && !queue.some((q) => q.url.includes('ag-1')),
      JSON.stringify(queue.map((q) => q.url)));

    // Объявление, у которого даты нет на странице, не должно попадать в
    // очередь каждую ночь и съедать весь проход.
    await setListingPage(ownerId, { postedAt: null, latitude: null, longitude: null });
    const queueAgain = await ownersWithoutDate(10);
    check('объявление без даты не встаёт в очередь навсегда',
      !queueAgain.some((q) => q.id === ownerId),
      JSON.stringify(queueAgain.map((q) => q.url)));

    // Снижение цены считается по НАШЕЙ истории.
    await db.prepare(
      `insert into market_prices (id, listing_id, price_usd_minor, price_kgs_minor, seen_at)
       values (?, ?, ?, null, ?)`,
    ).bind(crypto.randomUUID(), ownerId, 60000_00, longAgoIso).run();
    await db.prepare(
      `insert into market_prices (id, listing_id, price_usd_minor, price_kgs_minor, seen_at)
       values (?, ?, ?, null, ?)`,
    ).bind(crypto.randomUUID(), ownerId, 50000_00, iso()).run();

    const karakol = await ownerLeads({ deal: 'sale', kind: 'flat', city: 'Каракол', zone: null });
    check('в списке только собственники, агентств там нет',
      karakol.length === 1, String(karakol.length));
    check('снижение цены посчитано по нашей истории',
      karakol[0]?.row.drops === 1 && karakol[0]?.row.dropPercent === 17,
      JSON.stringify({ d: karakol[0]?.row.drops, p: karakol[0]?.row.dropPercent }));
    check('«—» в дате не выдаётся за дату публикации',
      karakol[0]?.daysFrom === 'наш обход', String(karakol[0]?.daysFrom));


    // -----------------------------------------------------------------
    // Журнал выгрузки: что ушло в фид и кто его забирал
    // -----------------------------------------------------------------
    //
    // До этого кабинет не знал, опубликован ли объект на площадке:
    // таблица publication_channels существовала, но писал в неё НИКТО —
    // отметки только снимались. Ответить «наше объявление уже на
    // house.kg?» можно было, лишь сходив туда руками.

    check('первый заход площадки записывается',
      await recordPull('house_kg', 'MHouseBot/1.0') === true);

    // Фид открыт всем: его дёргают поисковые роботы и проверялки ссылок.
    // Писать на каждый запрос значило бы отдать публичному адресу право
    // нагружать базу.
    check('частый опрос второй записи не делает',
      await recordPull('house_kg', 'MHouseBot/1.0') === false);

    const pull = await lastPull('house_kg');
    check('заход записан с тем, кто приходил',
      pull?.pulls === 1 && pull?.last_agent === 'MHouseBot/1.0',
      JSON.stringify(pull));
    check('чужой фид считается отдельно', await lastPull('yandex') === null);

    // Отметка «ушёл в выгрузку» ставится на объекты из файла.
    const feedIds = (await mhouseOffers('https://example.kg')).ids;
    await markExported(feedIds);

    if (feedIds.length > 0) {
      const state = await exportState(feedIds[0]);
      check('объект отмечен ушедшим в выгрузку',
        state.exportedAt !== null && state.status === 'exported',
        JSON.stringify(state));
      check('рядом с отметкой видно, когда площадка забирала фид',
        state.lastPullAt !== null, JSON.stringify(state));
    } else {
      check('в фиде нечего отмечать — проверка пропущена', true, 'фид пуст');
    }

    // Повторная отметка не плодит вторую связь: у пары «объект + канал»
    // стоит ограничение уникальности, и вторая вставка упала бы.
    await markExported(feedIds);
    const links = await db.prepare(
      `select count(*) as n from publication_channels where channel = 'house_kg'`,
    ).first<{ n: number }>();
    check('повторная выгрузка не плодит связей',
      (links?.n ?? 0) === feedIds.length, JSON.stringify({ n: links?.n, ids: feedIds.length }));

    // Объект, которого в фиде нет, отметки не получает.
    const notInFeed = await exportState('нет-такого-объекта');
    check('объект без выгрузки отметки не имеет',
      notInFeed.exportedAt === null && notInFeed.status === null,
      JSON.stringify(notInFeed));

    // --- своё объявление на площадке ---------------------------------
    //
    // У агентства свой аккаунт на house.kg, и его объявления попадают в
    // наш же индекс. Без распознавания проверка пугала бы агента его же
    // работой: «похоже, объект уже висит на house.kg».

    const ourAd = resemble(ourFlat, { ...theirs(), sellerName: 'Liberterra' }, null, 'Liberterra');
    check('объявление с нашей подписью узнаётся как своё',
      ourAd?.ours === true, JSON.stringify({ ours: ourAd?.ours }));

    check('чужое агентство своим не считается',
      resemble(ourFlat, theirs(), null, 'Liberterra')?.ours === false);

    check('без названия агентства своим не считается никто',
      resemble(ourFlat, { ...theirs(), sellerName: 'Liberterra' }, null, null)?.ours === false);

    // Расхождения у своего объявления показываются ТОЖЕ, и они важнее
    // чужих: в кабинете одна цена, в нашем же объявлении другая.
    check('у своего объявления расхождения всё равно названы',
      ourAd?.differences.some((d) => d.what === 'цена') === true,
      JSON.stringify(ourAd?.differences));

    const mixed = resembleAll(ourFlat, [
      theirs({ id: 'чужое' }),
      { ...theirs({ id: 'своё' }), sellerName: 'Liberterra' },
    ], null, 'Liberterra');
    check('своё объявление показывается первым',
      mixed[0]?.candidate.id === 'своё',
      mixed.map((r) => `${r.candidate.id}:${r.ours}`).join(' '));

    } catch (e) {
      // Падение посреди набора — это тоже результат, и он должен быть виден
      // списком, а не стеной текста вместо отчёта.
      check('прогон дошёл до конца', false, e instanceof Error ? e.message : String(e));
    }

    const failed = results.filter((r) => !r.ok);
    return Response.json(
      { total: results.length, failed: failed.length, results },
      { status: failed.length ? 500 : 200 },
    );
  },
};
