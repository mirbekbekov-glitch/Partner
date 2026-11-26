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
import { outbox, tokenFromLastLetter } from './stubs/email';
import {
  confirmActual, createObject, getObject, publishObject,
  updateObject, withdrawObject,
} from '@/lib/db/objects';
import { createMandate, expireMandates, terminateMandate } from '@/lib/db/mandates';
import { canSeeContact } from '@/lib/db/access';
import { createRequirement } from '@/lib/db/requirements';
import { createActivity, setActivityDone } from '@/lib/db/activities';
import { listLeads, setLeadStatus, submitLead } from '@/lib/db/leads';
import {
  catalogCities, catalogCount, catalogObject, catalogPage, catalogZoneCounts,
  catalogZones,
} from '@/lib/db/catalog';
import {
  deleteAvatar, deletePhoto, listPhotos, photoKey, photoUrl,
  photosMissingThumb, putAvatar, putPhoto, putThumb, readPhoto, sniff,
} from '@/lib/db/photos';
import { fullKeyOf, isOwnPhoto, thumbKey, thumbOf } from '@/lib/photo-url';
import { feedXml } from '@/lib/feed';
import {
  catalogHref, hasAnyFilter, parseCatalogFilters,
} from '@/lib/catalog-params';
import { listingSchema } from '@/lib/listing-schema';
import { placeName, t } from '@/lib/i18n';
import { citiesWithPlan, planFor } from '@/lib/city-plans';
import {
  completeTelegramLink, startTelegramLink, sweepTelegramLinks, unlinkTelegram,
} from '@/lib/db/telegram';
import { POST as telegramWebhook } from '@/app/api/telegram/webhook/route';
import {
  cabinetCounters, contactList, contactObjects, dealList, objectCard,
  objectList, requirementList,
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
} from '@/lib/db/contacts';
import { commissionShares, commissionTotal } from '@/lib/db/commission';
import { normalizePhone } from '@/lib/db/normalize';
import { Conflict, Forbidden, Invalid, NotFound } from '@/lib/db/errors';

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
    env: { DB: D1Database; PHOTOS: R2Bucket },
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
    // Объединение: порядок шагов и потеря данных
    // -----------------------------------------------------------------
    // Главный случай — запись БЕЗ связей с объектами. При неправильном
    // порядке RESTRICT промолчит, и потребности исчезнут без единой ошибки.
    const dupe = await createContact({ name: 'Иван Иванов', phone: '0555 40 50 60' });
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

    // Схемы районов по городам. Схема — не карта, и вся её ценность в
    // правде расположения: местный должен узнать город с первого
    // взгляда. Поэтому город попадает в список, только когда раскладку
    // назвал тот, кто город знает, а не тот, кто догадался.
    check('у Бишкека схема есть', planFor('Бишкек') !== null);
    check('у города без схемы её нет, и это не сбой', planFor('Ош') === null);
    check('пустой город схемы не получает',
      planFor(null) === null && planFor('') === null);

    // Названия в схеме обязаны совпадать с тем, что агенты пишут в поле
    // зоны: иначе ячейка никогда не наберёт ни одного объекта и навсегда
    // останется приглушённой.
    const plan = planFor('Бишкек');
    check('в схеме есть Центр — та же зона, что у объектов витрины',
      plan !== null && plan.cells.some((c) => c.name === 'Центр'));
    check('у схемы есть ось и названа она городской улицей',
      plan?.avenue === 'Чүй');
    check('схем ровно столько, сколько городов описали руками',
      citiesWithPlan().join() === 'Бишкек');

    // Как сайт себя называет. Пока город один — он; городов несколько —
    // страна. Текст считается по каталогу, а не правится руками: иначе
    // «Агентство недвижимости, Бишкек» в подвале устареет ровно в тот
    // день, когда кто-то заведёт объект в Оше, и никто не вспомнит.
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
    check('а в витрине он при этом есть — значит дело в фиде, а не в публикации',
      (await catalogPage({})).items.some((i) => i.id === commercial.id));

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

    const veraSees = await contactList();
    check('чужих контактов в списке нет',
      !veraSees.some((c) => c.id === annaContact.id),
      `видно ${veraSees.length} контактов`);
    check('свои контакты в списке есть',
      veraSees.some((c) => c.id === veraContact.id));

    // Объект виден всем — его ведёт коллега, это нормально, — но имя
    // собственника и право правки нет.
    const veraObjects = await objectList();
    const foreign = veraObjects.find((o) => o.id === annaObject.id);
    check('чужой объект в списке виден', Boolean(foreign));
    check('имя собственника чужого объекта закрыто',
      foreign?.owner_name === null, `показано: ${foreign?.owner_name}`);
    check('править чужой объект нельзя', foreign?.can_edit === false);

    await loginAs(db, anna);
    const annaObjects = await objectList();
    const own = annaObjects.find((o) => o.id === annaObject.id);
    check('своего собственника видно', own?.owner_name === 'Клиент Анны-2');
    check('свой объект править можно', own?.can_edit === true);

    check('объекты контакта видны владельцу записи',
      (await contactObjects(annaContact.id)).length === 1);
    await loginAs(db, vera);
    check('объекты чужого контакта не видны',
      (await contactObjects(annaContact.id)).length === 0);

    // Сделки: видит только сторона.
    await loginAs(db, anna);
    const annaDeals = await dealList();
    check('сторона сделки свои сделки видит', annaDeals.length > 0);

    await loginAs(db, vera);
    const veraDeals = await dealList();
    check('посторонний чужих сделок не видит',
      veraDeals.length === 0, `видно ${veraDeals.length}`);

    // Потребности: клиент закрыт, сама потребность видна.
    await loginAs(db, boris);
    await db.prepare(`update agents set status = 'approved' where id = ?`).bind(boris).run();
    await loginAs(db, boris);
    const needs = await requirementList();
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
