import 'server-only';
import { batch, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { activeMandateId } from './objects';
import { commissionShares, commissionTotal, parseRule } from './commission';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Сделки — инварианты 2 и 3.
 *
 * Инвариант 2: сделка только из подбора; закрытие закрывает мандат и
 * потребность. Половину этого держит схема — match_id NOT NULL, — вторую
 * половину держат проверки здесь: денормализованные ссылки обязаны
 * совпадать с подбором, иначе «сделка из подбора» выполняется формально, а
 * поля указывают на чужой объект.
 *
 * Инвариант 3: стороны комиссии берутся ИЗ МАНДАТА И ПОДБОРА, а не из
 * запроса. Это и есть защита от захвата доли: кто бы ни нажал кнопку, доли
 * уходят listing-агенту договора и агенту, ведущему клиента.
 *
 * В Postgres всё это держали два триггера, и они срабатывали даже на прямой
 * UPDATE. Здесь прямого UPDATE не существует: до таблицы можно дойти только
 * отсюда.
 */

export type DealRow = {
  id: string;
  match_id: string;
  object_id: string;
  requirement_id: string;
  mandate_id: string;
  listing_agent_id: string;
  closing_agent_id: string;
  final_price_minor: number | null;
  commission_total_minor: number | null;
  listing_share_minor: number | null;
  closing_share_minor: number | null;
  status: 'deposit' | 'documents' | 'signing' | 'settlement' | 'closed' | 'failed';
  failure_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function getDeal(id: string): Promise<DealRow | null> {
  return one<DealRow>('select * from deals where id = ?', id);
}

/** Сторона сделки: listing-агент, closing-агент или админ. */
export async function isDealParty(dealId: string): Promise<boolean> {
  if (await isAdmin()) return true;

  const agent = await requireAgent();
  const hit = await one<{ ok: number }>(
    `select 1 as ok from deals
      where id = ? and ? in (listing_agent_id, closing_agent_id)`,
    dealId, agent.id,
  );
  return hit !== null;
}

/**
 * Завести сделку из подбора — единственный способ её создать.
 *
 * Стороны не принимаются аргументами вовсе: listing-агент берётся из
 * активного мандата, closing-агент — из подбора. Передать их снаружи
 * означало бы дать выписать комиссию на себя.
 */
export async function createDealFromMatch(matchId: string): Promise<DealRow> {
  const agent = await requireAgent();

  const match = await one<{
    id: string; object_id: string; requirement_id: string;
    status: string; closing_agent_id: string;
  }>('select * from matches where id = ?', matchId);
  if (!match) throw new NotFound('Подбор не найден');

  if (match.status === 'rejected') {
    throw new Conflict('Сделка из отклонённого подбора невозможна');
  }

  const existing = await one<DealRow>('select * from deals where match_id = ?', matchId);
  if (existing) return existing;

  const mandateId = await activeMandateId(match.object_id);
  if (!mandateId) {
    throw new Conflict('У объекта нет активного мандата, сделка невозможна');
  }

  const mandate = await one<{ listing_agent_id: string }>(
    'select listing_agent_id from mandates where id = ?', mandateId,
  );
  if (!mandate) throw new NotFound('Мандат не найден');

  const id = newId();
  const at = now();

  await batch([
    stmt(
      `insert into deals (id, match_id, object_id, requirement_id, mandate_id,
                          listing_agent_id, closing_agent_id, status,
                          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 'deposit', ?, ?)`,
      id, match.id, match.object_id, match.requirement_id, mandateId,
      mandate.listing_agent_id, match.closing_agent_id, at, at,
    ),
    stmt(`update matches set status = 'in_deal', updated_at = ? where id = ?`, at, match.id),
    stmt(`update requirements set status = 'in_deal', updated_at = ? where id = ?`,
      at, match.requirement_id),
    auditStmt('deals', id, 'insert', agent.id, { match_id: match.id }),
  ]);

  const row = await getDeal(id);
  if (!row) throw new NotFound('Сделка не сохранилась');
  return row;
}

/** Движение по этапам. Закрытие и срыв — отдельными действиями: они финальны. */
export async function setDealStatus(
  dealId: string,
  status: 'deposit' | 'documents' | 'signing' | 'settlement',
): Promise<DealRow> {
  const agent = await requireAgent();

  const before = await getDeal(dealId);
  if (!before) throw new NotFound('Сделка не найдена');

  if (!(await isDealParty(dealId))) {
    throw new Forbidden('Вести сделку может только её участник или админ');
  }
  if (before.status === 'closed' || before.status === 'failed') {
    throw new Conflict('Сделка уже завершена');
  }

  const at = now();
  await batch([
    stmt('update deals set status = ?, updated_at = ? where id = ?', status, at, dealId),
    auditStmt('deals', dealId, 'update', agent.id,
      { status: { from: before.status, to: status } }),
  ]);

  const row = await getDeal(dealId);
  if (!row) throw new NotFound('Сделка не найдена');
  return row;
}

/**
 * Закрыть сделку — инварианты 2 и 3 разом.
 *
 * Считаем от ФИНАЛЬНОЙ цены и фиксируем суммы: до закрытия они были
 * индикативными и пересчитывались на лету, после закрытия пересчёту не
 * подлежат. Заодно закрываются мандат и потребность — сделка состоялась,
 * объект продан, искать больше нечего.
 *
 * Всё едет одним батчем. Иначе возможно состояние «сделка закрыта, а мандат
 * всё ещё активен», и объект остаётся в каталоге проданным.
 */
export async function closeDeal(
  dealId: string,
  finalPriceMinor: number,
): Promise<DealRow> {
  const agent = await requireAgent();

  const before = await getDeal(dealId);
  if (!before) throw new NotFound('Сделка не найдена');

  // Закрытие фиксирует деньги: сумму комиссии и обе доли. Делать это может
  // только сторона сделки.
  if (!(await isDealParty(dealId))) {
    throw new Forbidden('Закрыть сделку может только её участник или админ');
  }
  if (before.status === 'closed') throw new Conflict('Сделка уже закрыта');
  if (before.status === 'failed') throw new Conflict('Сделка сорвана, закрыть её нельзя');
  if (!(finalPriceMinor > 0)) {
    throw new Invalid('Финальная цена обязательна для закрытия сделки');
  }

  const context = await one<{ deal_type: 'rent' | 'sale'; commission_rule: string | null }>(
    `select o.deal_type, m.commission_rule
       from objects o join mandates m on m.id = ?
      where o.id = ?`,
    before.mandate_id, before.object_id,
  );
  if (!context) throw new NotFound('Объект или мандат сделки не найден');

  const total = commissionTotal(context.deal_type, finalPriceMinor,
    parseRule(context.commission_rule));
  const shares = commissionShares(total);
  const at = now();

  await batch([
    stmt(
      `update deals set status = 'closed', final_price_minor = ?,
                        commission_total_minor = ?, listing_share_minor = ?,
                        closing_share_minor = ?, closed_at = ?, updated_at = ?
        where id = ?`,
      finalPriceMinor, total, shares.listing, shares.closing, at, at, dealId,
    ),
    // Инвариант 2: закрытие сделки закрывает её мандат и её потребность.
    stmt(
      `update mandates set status = 'closed_by_deal', closed_reason = ?, updated_at = ?
        where id = ? and status <> 'closed_by_deal'`,
      `закрыт сделкой ${dealId}`, at, before.mandate_id,
    ),
    stmt(
      `update requirements set status = 'closed', closed_reason = ?, updated_at = ?
        where id = ? and status <> 'closed'`,
      `закрыта сделкой ${dealId}`, at, before.requirement_id,
    ),
    auditStmt('deals', dealId, 'update', agent.id, {
      status: { from: before.status, to: 'closed' },
      final_price_minor: { from: null, to: finalPriceMinor },
    }),
  ]);

  const row = await getDeal(dealId);
  if (!row) throw new NotFound('Сделка не найдена');
  return row;
}

/**
 * Сорвать сделку.
 *
 * Мандат и потребность при срыве НЕ закрываются: объект не продан, клиент
 * не нашёл — работа продолжается. Подбор возвращается в торг, иначе он
 * навсегда остался бы «в сделке», которой нет.
 */
export async function failDeal(dealId: string, reason: string): Promise<DealRow> {
  const agent = await requireAgent();

  const before = await getDeal(dealId);
  if (!before) throw new NotFound('Сделка не найдена');

  if (!(await isDealParty(dealId))) {
    throw new Forbidden('Отметить срыв может только участник сделки или админ');
  }
  if (before.status === 'closed') throw new Conflict('Закрытую сделку сорвать нельзя');

  const text = reason.trim();
  if (!text) throw new Invalid('Укажите причину срыва');

  const at = now();
  await batch([
    stmt(
      `update deals set status = 'failed', failure_reason = ?, updated_at = ?
        where id = ?`,
      text, at, dealId,
    ),
    stmt(
      `update matches set status = 'bargaining', updated_at = ?
        where id = ? and status = 'in_deal'`,
      at, before.match_id,
    ),
    stmt(
      `update requirements set status = 'qualified', updated_at = ?
        where id = ? and status = 'in_deal'`,
      at, before.requirement_id,
    ),
    auditStmt('deals', dealId, 'update', agent.id,
      { status: { from: before.status, to: 'failed' }, failure_reason: text }),
  ]);

  const row = await getDeal(dealId);
  if (!row) throw new NotFound('Сделка не найдена');
  return row;
}

/**
 * Индикативная комиссия до закрытия.
 *
 * Считается на лету и НЕ записывается: записанные суммы означали бы, что
 * деньги уже поделены. Инвариант 3 фиксирует их ровно один раз — при
 * закрытии, от финальной цены.
 */
export async function indicativeCommission(dealId: string): Promise<{
  total: number | null; listing: number | null; closing: number | null;
}> {
  const row = await one<{
    deal_type: 'rent' | 'sale'; price_minor: number;
    commission_rule: string | null; final_price_minor: number | null;
    commission_total_minor: number | null; listing_share_minor: number | null;
    closing_share_minor: number | null;
  }>(
    `select o.deal_type, o.price_minor, m.commission_rule, d.final_price_minor,
            d.commission_total_minor, d.listing_share_minor, d.closing_share_minor
       from deals d
       join objects  o on o.id = d.object_id
       join mandates m on m.id = d.mandate_id
      where d.id = ?`,
    dealId,
  );
  if (!row) return { total: null, listing: null, closing: null };

  // Закрытая сделка отдаёт зафиксированное, а не пересчитанное.
  if (row.commission_total_minor !== null) {
    return {
      total: row.commission_total_minor,
      listing: row.listing_share_minor,
      closing: row.closing_share_minor,
    };
  }

  const total = commissionTotal(row.deal_type,
    row.final_price_minor ?? row.price_minor, parseRule(row.commission_rule));
  const shares = commissionShares(total);
  return { total, listing: shares.listing, closing: shares.closing };
}
