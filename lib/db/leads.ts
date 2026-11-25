import 'server-only';
import { all, batch, from_now, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { requireAgent } from './session';
import { canEditObject } from './access';
import { normalizePhone } from './normalize';
import { Forbidden, Invalid, NotFound } from './errors';

/**
 * Заявки с сайта — ЕДИНСТВЕННАЯ запись в базу от неизвестного.
 *
 * До неё писать могли только одобренные агенты. Поэтому поверхность сведена
 * к одной функции, и все проверки живут здесь, а не в форме: форму обойти
 * тривиально, а раньше запрос уходил прямо в PostgREST. Теперь до базы
 * вообще не дотянуться мимо Worker, но правило остаётся тем же — проверять
 * на сервере, потому что форма это удобство, а не защита.
 *
 * Телефон заявителя — такой же чувствительный, как телефон собственника, и
 * живёт по тому же правилу: видит тот, кто ведёт объект, и админ. Предикат
 * взят тот же, что у правки объекта (canEditObject), — иначе вышло бы, что
 * снять объект с публикации агент может, а читать телефоны его заявителей
 * нет.
 */

export type LeadRow = {
  id: string;
  object_id: string;
  name: string;
  phone: string;
  phone_normalized: string;
  message: string | null;
  status: 'new' | 'in_work' | 'done' | 'spam';
  agent_id: string | null;
  activity_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Сколько заявок с одного номера в час — уже не человек. */
const PER_PHONE_PER_HOUR = 5;
/** И сколько по одному объекту: столько живого интереса за час не бывает. */
const PER_OBJECT_PER_HOUR = 30;

/** Та же пара «телефон + объект» за сутки — это один и тот же человек. */
const SAME_LEAD_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LeadInput = {
  object_id: string;
  name: string;
  phone: string;
  message?: string | null;
  /** Поле-приманка формы. Заполнено — отвечаем как при успехе, но не пишем. */
  trap?: string | null;
};

/**
 * Принять заявку.
 *
 * Возвращает идентификатор заявки — свой или прежний, если это повтор.
 * Человек, нажавший дважды, не должен получить двух звонков.
 */
export async function submitLead(input: LeadInput): Promise<string> {
  const at = now();

  // Бот заполнил скрытое поле: отвечаем как при успехе, но в базу ничего не
  // идёт. Отказ сказал бы боту, что приманка распознана.
  if ((input.trap ?? '').trim() !== '') return newId();

  // Объект должен быть опубликован. Эта проверка и ограничивает права, и не
  // выдаёт существование черновика: ответ один и тот же, иначе черновики
  // находятся перебором.
  const object = await one<{ address: string }>(
    `select address from objects where id = ? and publication_state = 'published'`,
    input.object_id,
  );
  if (!object) throw new NotFound('Объект не найден или снят с публикации');

  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new Invalid('Имя обязательно и не длиннее 120 символов');
  }

  const message = (input.message ?? '').trim() || null;
  if (message && message.length > 2000) {
    throw new Invalid('Сообщение не длиннее 2000 символов');
  }

  const normalized = normalizePhone(input.phone);
  if (normalized.length < 9) throw new Invalid('Телефон не похож на номер');

  // Повтор той же пары за сутки: отдаём прежнюю заявку.
  const repeat = await one<{ id: string }>(
    `select id from leads
      where object_id = ? and phone_normalized = ? and created_at > ?
      order by created_at desc limit 1`,
    input.object_id, normalized, new Date(Date.now() - SAME_LEAD_WINDOW_MS).toISOString(),
  );
  if (repeat) return repeat.id;

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const byPhone = await one<{ n: number }>(
    'select count(*) as n from leads where phone_normalized = ? and created_at > ?',
    normalized, hourAgo,
  );
  if ((byPhone?.n ?? 0) >= PER_PHONE_PER_HOUR) {
    throw new Invalid('Слишком много заявок с этого номера, попробуйте позже');
  }

  const byObject = await one<{ n: number }>(
    'select count(*) as n from leads where object_id = ? and created_at > ?',
    input.object_id, hourAgo,
  );
  if ((byObject?.n ?? 0) >= PER_OBJECT_PER_HOUR) {
    throw new Invalid('Слишком много заявок по этому объекту, попробуйте позже');
  }

  // Кому звонить: listing-агент активного мандата, иначе тот, кто завёл.
  const responsible = await one<{ agent_id: string | null }>(
    `select coalesce(
              (select m.listing_agent_id from mandates m
                where m.object_id = ?1 and m.status = 'active' limit 1),
              (select o.created_by_agent_id from objects o where o.id = ?1)
            ) as agent_id`,
    input.object_id,
  );

  const id = newId();
  const writes = [];
  let activityId: string | null = null;

  if (responsible?.agent_id) {
    activityId = newId();
    // Заявка, о которой никому не сказали, бесполезна. Срок через два часа —
    // дальше её подхватывают обычные напоминания.
    //
    // is_shared = 0: в задаче стоит имя заявителя, и видеть её должен тот,
    // кто ведёт объект, а не все коллеги. Телефона в тексте нет — он живёт
    // в заявке, под своим правилом видимости.
    writes.push(stmt(
      `insert into activities (id, kind, entity_type, entity_id, agent_id, body,
                               due_at, done, is_shared, created_at, updated_at)
       values (?, 'call', 'object', ?, ?, ?, ?, 0, 0, ?, ?)`,
      activityId, input.object_id, responsible.agent_id,
      `Заявка с сайта по «${object.address}»: ${name}. Телефон — в разделе «Заявки».`,
      from_now(2 * 60 * 60 * 1000), at, at,
    ));
  }

  writes.push(stmt(
    `insert into leads (id, object_id, name, phone, phone_normalized, message,
                        status, activity_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
    id, input.object_id, name, input.phone.trim(), normalized, message,
    activityId, at, at,
  ));
  // Автор заявки — не агент, поэтому в журнале стоит «система».
  writes.push(auditStmt('leads', id, 'insert', null, { object_id: input.object_id }));

  await batch(writes);
  return id;
}

/**
 * Заявки по объектам агента.
 *
 * Выдача ограничена теми объектами, которые агент вправе править, — тем же
 * предикатом, что и всё остальное про объект.
 */
export async function listLeads(status?: LeadRow['status']): Promise<LeadRow[]> {
  const agent = await requireAgent();
  const admin = agent.role === 'admin';

  const params: (string | number)[] = [];
  let where = '';

  if (!admin) {
    where = `and (exists (select 1 from objects o
                           where o.id = l.object_id and o.created_by_agent_id = ?)
              or exists (select 1 from mandates m
                          where m.object_id = l.object_id and m.status = 'active'
                            and m.listing_agent_id = ?))`;
    params.push(agent.id, agent.id);
  }

  if (status) {
    where += ' and l.status = ?';
    params.push(status);
  }

  return all<LeadRow>(
    `select l.* from leads l where 1 = 1 ${where} order by l.created_at desc limit 200`,
    ...params,
  );
}

/** Взять в работу, отметить отработанной, пометить спамом. */
export async function setLeadStatus(
  leadId: string,
  status: LeadRow['status'],
): Promise<LeadRow> {
  const agent = await requireAgent();

  const before = await one<LeadRow>('select * from leads where id = ?', leadId);
  if (!before) throw new NotFound('Заявка не найдена');

  if (!(await canEditObject(before.object_id))) {
    throw new Forbidden('Заявку ведёт тот, кто отвечает за объект, или админ');
  }

  const at = now();
  const writes = [
    stmt(
      `update leads set status = ?, agent_id = ?, updated_at = ? where id = ?`,
      status, status === 'new' ? null : agent.id, at, leadId,
    ),
    auditStmt('leads', leadId, 'update', agent.id,
      { status: { from: before.status, to: status } }),
  ];

  // Отработанная или спамная заявка не должна дёргать агента задачей.
  if ((status === 'done' || status === 'spam') && before.activity_id) {
    writes.push(stmt(
      'update activities set done = 1, done_at = ?, updated_at = ? where id = ? and done = 0',
      at, at, before.activity_id,
    ));
    writes.push(stmt(
      `update notifications set status = 'cancelled'
        where activity_id = ? and status in ('pending', 'sending')`,
      before.activity_id,
    ));
  }

  await batch(writes);

  const row = await one<LeadRow>('select * from leads where id = ?', leadId);
  if (!row) throw new NotFound('Заявка не найдена');
  return row;
}
