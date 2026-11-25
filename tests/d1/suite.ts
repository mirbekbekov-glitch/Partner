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
import { catalogObject, catalogPage, catalogZones } from '@/lib/db/catalog';
import {
  cabinetCounters, contactList, contactObjects, dealList, objectList,
  requirementList,
} from '@/lib/db/cabinet';
import {
  approveAgent, blockAgent, clearMyOrganization, confirmAgentOrganization,
  ensureAgentByEmail, getAgent, setAgentRole, setMyOrganization, updateProfile,
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
  async fetch(_request: Request, env: { DB: D1Database }): Promise<Response> {
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
