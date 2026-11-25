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

import { SESSION_COOKIE } from '@/lib/db/session';
import {
  confirmActual, createObject, getObject, publishObject,
  updateObject, withdrawObject,
} from '@/lib/db/objects';
import { createMandate, expireMandates, terminateMandate } from '@/lib/db/mandates';
import { canSeeContact } from '@/lib/db/access';
import { createRequirement } from '@/lib/db/requirements';
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
import { Conflict, Forbidden } from '@/lib/db/errors';

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
