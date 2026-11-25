import 'server-only';
import { all, batch, bool, flag, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { Forbidden, Invalid, NotFound } from './errors';

/**
 * Активности: звонки, показы, задачи, заметки.
 *
 * Ссылка на сущность полиморфная — entity_type плюс entity_id, — поэтому
 * внешним ключом её не удержать. В Postgres существование проверял триггер;
 * здесь это делает checkTarget() перед записью.
 */

export type ActivityRow = {
  id: string;
  kind: 'call' | 'showing' | 'task' | 'note' | 'message';
  entity_type: 'contact' | 'object' | 'mandate' | 'requirement' | 'match' | 'deal';
  entity_id: string;
  agent_id: string;
  body: string | null;
  due_at: string | null;
  done: number;
  done_at: string | null;
  is_shared: number;
  created_at: string;
  updated_at: string;
};

/** Таблица, в которой живёт сущность этого типа. */
const TABLES: Record<ActivityRow['entity_type'], string> = {
  contact: 'contacts',
  object: 'objects',
  mandate: 'mandates',
  requirement: 'requirements',
  match: 'matches',
  deal: 'deals',
};

/**
 * Сущность существует.
 *
 * Имя таблицы берётся из словаря выше, а не из аргумента: подставлять в
 * текст запроса пришедшее снаружи значение — это внедрение SQL, даже когда
 * кажется, что значение «своё».
 */
async function checkTarget(type: ActivityRow['entity_type'], id: string): Promise<void> {
  const table = TABLES[type];
  if (!table) throw new Invalid('Неизвестный вид сущности');

  const hit = await one<{ id: string }>(`select id from ${table} where id = ?`, id);
  if (!hit) throw new NotFound(`Запись, к которой привязана активность, не найдена`);
}

export async function listActivities(
  type: ActivityRow['entity_type'],
  id: string,
): Promise<ActivityRow[]> {
  await requireAgent();
  return all<ActivityRow>(
    `select * from activities where entity_type = ? and entity_id = ?
      order by coalesce(due_at, created_at) desc`,
    type, id,
  );
}

/** Личный список задач: свои незакрытые, по сроку. */
export async function myTasks(): Promise<ActivityRow[]> {
  const agent = await requireAgent();
  return all<ActivityRow>(
    `select * from activities
      where agent_id = ? and done = 0 and kind in ('task', 'showing')
      order by due_at is null, due_at`,
    agent.id,
  );
}

export type NewActivity = {
  kind: ActivityRow['kind'];
  entity_type: ActivityRow['entity_type'];
  entity_id: string;
  body?: string | null;
  due_at?: string | null;
  is_shared?: boolean;
  /** Кому задача. По умолчанию себе. */
  agent_id?: string | null;
};

export async function createActivity(input: NewActivity): Promise<ActivityRow> {
  const agent = await requireAgent();
  await checkTarget(input.entity_type, input.entity_id);

  // Задача и показ без срока бессмысленны: напоминать не о чем.
  if ((input.kind === 'task' || input.kind === 'showing') && !input.due_at) {
    throw new Invalid('У задачи и показа должен быть срок');
  }

  const id = newId();
  const at = now();

  await batch([
    stmt(
      `insert into activities (id, kind, entity_type, entity_id, agent_id, body,
                               due_at, done, is_shared, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id, input.kind, input.entity_type, input.entity_id,
      input.agent_id ?? agent.id,
      (input.body ?? '').trim() || null, input.due_at ?? null,
      flag(input.is_shared ?? false), at, at,
    ),
    auditStmt('activities', id, 'insert', agent.id,
      { kind: input.kind, entity_type: input.entity_type }),
  ]);

  const row = await one<ActivityRow>('select * from activities where id = ?', id);
  if (!row) throw new NotFound('Активность не сохранилась');
  return row;
}

/**
 * Отметить выполненной — и погасить напоминание.
 *
 * Гашение едет тем же батчем: иначе выполненная задача всё равно дёрнет
 * агента, потому что напоминание уже стояло в очереди.
 */
export async function setActivityDone(id: string, done: boolean): Promise<ActivityRow> {
  const agent = await requireAgent();

  const before = await one<ActivityRow>('select * from activities where id = ?', id);
  if (!before) throw new NotFound('Активность не найдена');

  if (before.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Закрыть задачу может тот, на ком она, или админ');
  }

  const at = now();
  const writes = [
    stmt('update activities set done = ?, done_at = ?, updated_at = ? where id = ?',
      flag(done), done ? at : null, at, id),
    auditStmt('activities', id, 'update', agent.id,
      { done: { from: bool(before.done), to: done } }),
  ];

  if (done) {
    writes.push(stmt(
      `update notifications set status = 'cancelled'
        where activity_id = ? and status in ('pending', 'sending')`,
      id,
    ));
  }

  await batch(writes);

  const row = await one<ActivityRow>('select * from activities where id = ?', id);
  if (!row) throw new NotFound('Активность не найдена');
  return row;
}

export async function deleteActivity(id: string): Promise<void> {
  const agent = await requireAgent();

  const before = await one<ActivityRow>('select * from activities where id = ?', id);
  if (!before) throw new NotFound('Активность не найдена');

  if (before.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Удалить запись может тот, на ком она, или админ');
  }

  await batch([
    // Напоминание живёт ровно столько, сколько задача: каскад снимет его сам.
    stmt('delete from activities where id = ?', id),
    auditStmt('activities', id, 'delete', agent.id, { kind: before.kind }),
  ]);
}
