import 'server-only';
import { now, stmt, toJson } from './sql';

/**
 * Журнал действий — инвариант 7: кто, что и когда менял.
 *
 * В Postgres его вёл триггер app.write_audit() на одиннадцати таблицах, и
 * обойти его было нельзя: любая запись проходила через триггер. Здесь
 * триггеров нет, поэтому запись в журнал кладётся В ТОТ ЖЕ БАТЧ, что и сама
 * правка. Это важно: батч D1 — транзакция, значит изменение без записи в
 * журнал не сохранится в принципе. Отдельный вызов после правки такого
 * свойства не даёт — упадёт он, и правка останется неучтённой.
 */

export type AuditAction = 'insert' | 'update' | 'delete';

/** Что изменилось: {"price_minor": {"from": 100, "to": 120}}. */
export type Diff = Record<string, { from: unknown; to: unknown }>;

/**
 * Запись журнала как запрос для батча.
 *
 * Возвращает запрос, а не выполняет его, намеренно — см. пояснение выше.
 */
export function auditStmt(
  entityType: string,
  entityId: string,
  action: AuditAction,
  actorAgentId: string | null,
  diff: Diff | Record<string, unknown> = {},
) {
  return stmt(
    `insert into audit_log (entity_type, entity_id, action, actor_agent_id, diff, at)
     values (?, ?, ?, ?, ?, ?)`,
    entityType, entityId, action, actorAgentId, toJson(diff), now(),
  );
}

/**
 * Разница между «было» и «стало» — только по изменившимся полям.
 *
 * Хранить полный снимок строки было бы и дороже, и вреднее: в журнал
 * попадали бы телефоны собственников при каждой правке соседнего поля.
 */
export function diffOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Diff {
  const out: Diff = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      out[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return out;
}
