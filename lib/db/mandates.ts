import 'server-only';
import { batch, flag, newId, now, one, run, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { activeMandateId } from './objects';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Мандаты — вторая половина инварианта 1.
 *
 * Первую держит схема: частичный уникальный индекс не даёт завести второй
 * активный договор на объект. Вторую держит этот модуль: как только мандат
 * перестаёт быть активным, объект уходит из каталога — иначе в каталоге
 * висело бы объявление без действующего договора.
 *
 * В Postgres это делал триггер after update on mandates. Здесь — функция
 * releaseStmts(), и она вызывается из КАЖДОГО места, где мандат теряет
 * активность: расторжение, истечение, закрытие сделкой. Пропустить её
 * означает оставить каталог рассогласованным.
 */

export type MandateRow = {
  id: string;
  object_id: string;
  kind: 'exclusive' | 'non_exclusive';
  valid_from: string;
  valid_to: string | null;
  start_price_minor: number;
  commission_rule: string | null;
  listing_agent_id: string;
  contract_confirmed: number;
  document_url: string | null;
  document_hash: string | null;
  status: 'active' | 'expired' | 'terminated' | 'closed_by_deal';
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
};

/** Сегодняшняя дата в том виде, в каком лежат valid_from и valid_to. */
function today(): string {
  return now().slice(0, 10);
}

/**
 * Запросы, снимающие объект с публикации вслед за мандатом.
 *
 * Возвращает запросы, а не выполняет: они обязаны ехать тем же батчем, что
 * и смена статуса мандата. Иначе между двумя вызовами существует момент,
 * когда объект опубликован без действующего договора, — и если второй вызов
 * не состоится, он останется таким навсегда.
 */
export function releaseStmts(objectId: string, at: string) {
  return [
    stmt(
      `update objects set publication_state = 'withdrawn', updated_at = ?
        where id = ? and publication_state = 'published'
          and not exists (select 1 from mandates m
                           where m.object_id = objects.id and m.status = 'active')`,
      at, objectId,
    ),
    stmt(
      `update publication_channels set status = 'withdrawn', last_sync_at = ?, updated_at = ?
        where object_id = ? and status in ('exported', 'updated')
          and not exists (select 1 from mandates m
                           where m.object_id = publication_channels.object_id
                             and m.status = 'active')`,
      at, at, objectId,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Заключение
// ---------------------------------------------------------------------------

export type NewMandate = {
  object_id: string;
  kind: 'exclusive' | 'non_exclusive';
  start_price_minor?: number | null;
  valid_to?: string | null;
  contract_confirmed?: boolean;
  document_url?: string | null;
  commission_rule?: string | null;
  /** Доля партнёра в процентах от комиссии. Пусто — половина. */
  partner_share?: number | null;
};

/**
 * Заключить мандат.
 *
 * Здесь когда-то стояла проверка «только тот, кто завёл объект», и она
 * оказалась неверной. Обычная ситуация: объект внёс один агент, а договор с
 * собственником есть у другого. При строгой проверке второй не может его
 * оформить, и объект остаётся непубликуемым, пока не вмешается первый.
 *
 * Заключение договора — это принесённая работа, а не действие над чужой.
 * Поэтому требование одно: активного мандата у объекта ещё нет. Публикация,
 * снятие и подтверждение актуальности остаются строгими — это действия над
 * объектом, который уже кому-то принадлежит.
 *
 * Остаточный риск признаю: агент может оформить договор на объект, который
 * внёс другой, и получить половину комиссии. Он виден — в журнале записано,
 * кто и когда завёл мандат, — и обратим: админ расторгает. Запрет же ломает
 * честный случай каждый раз.
 */
/**
 * Доля партнёра из формы: целый процент от 0 до 100 — или пусто.
 *
 * Ноль разрешён и означает именно ноль: «клиентов ищу сам, делиться не
 * готов». Это честный ответ, и прятать его нельзя — иначе агент напишет
 * «1» и партнёр потратит время на звонок впустую.
 */
function partnerShareValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Math.trunc(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Invalid('Доля партнёра — целое число процентов от 0 до 100');
  }
  return n;
}

export async function createMandate(input: NewMandate): Promise<MandateRow> {
  const agent = await requireAgent();

  const object = await one<{ id: string; price_minor: number }>(
    'select id, price_minor from objects where id = ?', input.object_id,
  );
  if (!object) throw new NotFound('Объект не найден');

  if (await activeMandateId(input.object_id)) {
    throw new Conflict(
      'У объекта уже есть активный мандат. Сначала расторгните действующий договор.',
    );
  }

  // Мандат нельзя активировать со сроком, который уже прошёл: иначе объект
  // публикуется договором, которого нет.
  if (input.valid_to && input.valid_to < today()) {
    throw new Invalid(`Мандат нельзя заключить со сроком до ${input.valid_to}`);
  }

  const id = newId();
  const at = now();
  const startPrice = input.start_price_minor ?? object.price_minor;
  if (!(startPrice > 0)) throw new Invalid('Цена по договору должна быть больше нуля');

  const share = partnerShareValue(input.partner_share);

  await batch([
    stmt(
      `insert into mandates (id, object_id, kind, valid_from, valid_to,
                             start_price_minor, commission_rule, partner_share,
                             listing_agent_id,
                             contract_confirmed, document_url, status,
                             created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id, input.object_id, input.kind, today(), input.valid_to ?? null,
      startPrice, input.commission_rule ?? null, share, agent.id,
      flag(input.contract_confirmed ?? false),
      (input.document_url ?? '').trim() || null, at, at,
    ),
    auditStmt('mandates', id, 'insert', agent.id, {
      object_id: input.object_id, kind: input.kind,
    }),
  ]);

  const row = await one<MandateRow>('select * from mandates where id = ?', id);
  if (!row) throw new NotFound('Мандат не сохранился');
  return row;
}

// ---------------------------------------------------------------------------
// Расторжение и истечение
// ---------------------------------------------------------------------------

/** Расторгнуть договор. Объект уходит из каталога тем же батчем. */
export async function terminateMandate(
  mandateId: string,
  reason?: string | null,
): Promise<MandateRow> {
  const agent = await requireAgent();

  const mandate = await one<MandateRow>(
    'select * from mandates where id = ?', mandateId,
  );
  if (!mandate || mandate.status !== 'active') {
    throw new NotFound('Активный мандат не найден');
  }

  if (mandate.listing_agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Расторгнуть договор может его listing-агент или админ');
  }

  const at = now();

  await batch([
    stmt(
      `update mandates set status = 'terminated', closed_reason = ?, updated_at = ?
        where id = ? and status = 'active'`,
      (reason ?? '').trim() || null, at, mandateId,
    ),
    ...releaseStmts(mandate.object_id, at),
    auditStmt('mandates', mandateId, 'update', agent.id, {
      status: { from: 'active', to: 'terminated' },
    }),
  ]);

  const row = await one<MandateRow>('select * from mandates where id = ?', mandateId);
  if (!row) throw new NotFound('Мандат не найден');
  return row;
}

/**
 * Погасить мандаты, у которых вышел срок, — и снять их объекты с каталога.
 *
 * Вызывается расписанием. Без этого вызова объект остаётся опубликованным с
 * просроченным договором: инвариант 1 держится датой, а дата сама себя не
 * проверяет.
 *
 * Здесь нет require_agent(): это фоновое задание, сессии у него нет. В
 * Postgres такую функцию мог позвать любой вошедший агент, и однажды это
 * опустошило каталог. Теперь позвать её извне нечем — она не выставлена
 * наружу ни одним маршрутом, кроме расписания Worker.
 */
export async function expireMandates(): Promise<number> {
  const at = now();
  const day = today();

  const due = await (await import('./sql')).all<{ id: string; object_id: string }>(
    `select id, object_id from mandates
      where status = 'active' and valid_to is not null and valid_to < ?`,
    day,
  );
  if (due.length === 0) return 0;

  const writes = [
    stmt(
      `update mandates set status = 'expired', updated_at = ?
        where status = 'active' and valid_to is not null and valid_to < ?`,
      at, day,
    ),
  ];
  for (const m of due) {
    writes.push(...releaseStmts(m.object_id, at));
    writes.push(auditStmt('mandates', m.id, 'update', null, {
      status: { from: 'active', to: 'expired' },
    }));
  }

  await batch(writes);
  return due.length;
}

export { run };
