import 'server-only';
import { batch, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { activeMandateId } from './objects';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Подборы — вход в инвариант 2.
 *
 * Сделки без подбора не существует, поэтому подбор здесь не «пометка
 * интереса», а запись о том, кто кому что показывает и кто за это получит
 * долю комиссии.
 */

export type MatchRow = {
  id: string;
  object_id: string;
  requirement_id: string;
  status: 'proposed' | 'interested' | 'showing_scheduled' | 'showing_done'
        | 'bargaining' | 'rejected' | 'in_deal';
  rejection_reason: string | null;
  showing_at: string | null;
  closing_agent_id: string;
  created_by_agent_id: string;
  created_at: string;
  updated_at: string;
};

/** Вести подбор может агент, ведущий клиента, автор подбора или админ. */
export async function canLeadMatch(matchId: string): Promise<boolean> {
  if (await isAdmin()) return true;

  const agent = await requireAgent();
  const hit = await one<{ ok: number }>(
    `select 1 as ok from matches m
       join requirements r on r.id = m.requirement_id
      where m.id = ? and (m.closing_agent_id = ?2 or m.created_by_agent_id = ?2
                          or r.agent_id = ?2)`,
    matchId, agent.id,
  );
  return hit !== null;
}

/**
 * Создать подбор.
 *
 * closing-агент берётся ИЗ ПОТРЕБНОСТИ, а не из того, кто нажал. Прежде он
 * ставился равным вызывающему, и это был захват комиссии: по инварианту 3
 * доля closing-агента идёт тому, кто указан в подборе. Теперь она идёт
 * агенту, который ведёт клиента, кто бы подбор ни создал. Предлагать объект
 * чужому клиенту при этом по-прежнему можно — это полезно и больше ничего
 * не ломает.
 */
export async function createMatch(
  objectId: string,
  requirementId: string,
): Promise<MatchRow> {
  const agent = await requireAgent();

  const object = await one<{ id: string; deal_type: string }>(
    'select id, deal_type from objects where id = ?', objectId,
  );
  if (!object) throw new NotFound('Объект не найден');

  const requirement = await one<{ id: string; deal_type: string; agent_id: string }>(
    'select id, deal_type, agent_id from requirements where id = ?', requirementId,
  );
  if (!requirement) throw new NotFound('Потребность не найдена');

  if (object.deal_type !== requirement.deal_type) {
    throw new Invalid(
      'Объект и потребность разного направления: аренду с продажей не подбирают',
    );
  }

  const existing = await one<MatchRow>(
    'select * from matches where object_id = ? and requirement_id = ?',
    objectId, requirementId,
  );
  if (existing) return existing;

  const id = newId();
  const at = now();

  await batch([
    stmt(
      `insert into matches (id, object_id, requirement_id, status,
                            closing_agent_id, created_by_agent_id,
                            created_at, updated_at)
       values (?, ?, ?, 'proposed', ?, ?, ?, ?)`,
      id, objectId, requirementId, requirement.agent_id, agent.id, at, at,
    ),
    auditStmt('matches', id, 'insert', agent.id,
      { object_id: objectId, requirement_id: requirementId }),
  ]);

  const row = await one<MatchRow>('select * from matches where id = ?', id);
  if (!row) throw new NotFound('Подбор не сохранился');
  return row;
}

/** Ведение подбора по статусам. */
export async function setMatchStatus(
  matchId: string,
  status: MatchRow['status'],
  options: { reason?: string | null; showing_at?: string | null } = {},
): Promise<MatchRow> {
  const agent = await requireAgent();

  const before = await one<MatchRow>('select * from matches where id = ?', matchId);
  if (!before) throw new NotFound('Подбор не найден');

  if (!(await canLeadMatch(matchId))) {
    throw new Forbidden(
      'Вести подбор может агент, ведущий клиента, автор подбора или админ',
    );
  }

  // Инвариант 2: «в сделке» ставится созданием сделки, а не руками.
  if (status === 'in_deal' && before.status !== 'in_deal') {
    throw new Conflict(
      'Статус «в сделке» ставится созданием сделки из подбора, а не вручную',
    );
  }

  const reason = (options.reason ?? '').trim();
  // Отказ без причины бессмыслен: аналитика отвала строится на ней.
  if (status === 'rejected' && !reason && !before.rejection_reason) {
    throw new Invalid('Укажите причину отказа');
  }

  const showing = options.showing_at ?? before.showing_at;
  // Назначенный показ без даты — не назначенный показ.
  if (status === 'showing_scheduled' && !showing) {
    throw new Invalid('Укажите дату и время показа');
  }
  if (status === 'showing_done' && !showing) {
    throw new Invalid('Укажите, когда показ состоялся');
  }

  const at = now();
  await batch([
    stmt(
      `update matches set status = ?, rejection_reason = ?, showing_at = ?,
                          updated_at = ? where id = ?`,
      status, reason || before.rejection_reason, showing, at, matchId,
    ),
    auditStmt('matches', matchId, 'update', agent.id,
      { status: { from: before.status, to: status } }),
  ]);

  const row = await one<MatchRow>('select * from matches where id = ?', matchId);
  if (!row) throw new NotFound('Подбор не найден');
  return row;
}

export { activeMandateId };
