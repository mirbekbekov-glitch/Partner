import 'server-only';
import { batch, jsonArray, newId, now, one, stmt, toJson } from './sql';
import { auditStmt, diffOf } from './audit';
import { isAdmin, requireAgent } from './session';
import { normalizePhone } from './normalize';
import { Forbidden, Invalid, NotFound } from './errors';

/**
 * Потребности — что ищет клиент.
 *
 * Ведущий агент потребности важен не для порядка, а для денег: по
 * инварианту 3 именно он становится closing-агентом подбора, а значит
 * получает долю комиссии. Поэтому сменить его можно только передачей
 * (transferRequirement), и это записывается в журнал.
 */

export type RequirementRow = {
  id: string;
  contact_id: string;
  deal_type: 'rent' | 'sale';
  budget_min_minor: number | null;
  budget_max_minor: number | null;
  zones: string;
  rooms: string;
  deadline: string | null;
  requirements_text: string | null;
  agent_id: string;
  status: 'new' | 'qualified' | 'in_showings' | 'in_deal' | 'closed' | 'lost';
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type RequirementView = Omit<RequirementRow, 'zones' | 'rooms'> & {
  zones: string[];
  rooms: number[];
};

function view(row: RequirementRow): RequirementView {
  return {
    ...row,
    zones: jsonArray<string>(row.zones),
    rooms: jsonArray<number>(row.rooms),
  };
}

export async function getRequirement(id: string): Promise<RequirementView | null> {
  const row = await one<RequirementRow>('select * from requirements where id = ?', id);
  return row ? view(row) : null;
}

export type NewRequirement = {
  deal_type: 'rent' | 'sale';
  contact_id?: string | null;
  client_name?: string | null;
  client_phone?: string | null;
  budget_min_minor?: number | null;
  budget_max_minor?: number | null;
  zones?: string[];
  rooms?: number[];
  deadline?: string | null;
  requirements_text?: string | null;
};

export async function createRequirement(
  input: NewRequirement,
): Promise<RequirementView> {
  const agent = await requireAgent();
  const at = now();
  const writes = [];

  let contactId = input.contact_id ?? null;
  const clientName = (input.client_name ?? '').trim();

  // Новый клиент достаётся тому, кто его привёл: на этом держится инвариант 4.
  if (!contactId && clientName) {
    contactId = newId();
    const roles = input.deal_type === 'rent' ? ['tenant'] : ['buyer'];

    writes.push(stmt(
      `insert into contacts (id, kind, name, owner_agent_id, roles, source,
                             created_at, updated_at)
       values (?, 'person', ?, ?, ?, 'заведён с потребностью', ?, ?)`,
      contactId, clientName, agent.id, toJson(roles), at, at,
    ));
    writes.push(auditStmt('contacts', contactId, 'insert', agent.id, { name: clientName }));

    const phone = (input.client_phone ?? '').trim();
    if (phone) {
      writes.push(stmt(
        `insert into contact_phones (id, contact_id, phone, phone_normalized,
                                     is_primary, created_at)
         values (?, ?, ?, ?, 1, ?)`,
        newId(), contactId, phone, normalizePhone(phone), at,
      ));
    }
  }

  if (!contactId) {
    throw new Invalid('Потребность без клиента невозможна: укажите контакт или имя');
  }

  const min = input.budget_min_minor ?? null;
  const max = input.budget_max_minor ?? null;
  if (min !== null && max !== null && max < min) {
    throw new Invalid('Верхняя граница бюджета ниже нижней');
  }

  const id = newId();
  writes.push(stmt(
    `insert into requirements (id, contact_id, deal_type, budget_min_minor,
                               budget_max_minor, zones, rooms, deadline,
                               requirements_text, agent_id, status,
                               created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    id, contactId, input.deal_type, min, max,
    toJson(input.zones ?? []), toJson(input.rooms ?? []),
    input.deadline ?? null,
    (input.requirements_text ?? '').trim() || null,
    agent.id, at, at,
  ));
  writes.push(auditStmt('requirements', id, 'insert', agent.id,
    { contact_id: contactId, deal_type: input.deal_type }));

  await batch(writes);

  const created = await getRequirement(id);
  if (!created) throw new NotFound('Потребность не сохранилась');
  return created;
}

/** Ведёт потребность её агент; админ может всё. */
async function requireOwnRequirement(id: string): Promise<RequirementRow> {
  const agent = await requireAgent();
  const row = await one<RequirementRow>('select * from requirements where id = ?', id);
  if (!row) throw new NotFound('Потребность не найдена');

  if (row.agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Вести потребность может её агент или админ');
  }
  return row;
}

export type RequirementPatch = Partial<Pick<NewRequirement,
  'budget_min_minor' | 'budget_max_minor' | 'zones' | 'rooms'
  | 'deadline' | 'requirements_text'>> & {
  status?: RequirementRow['status'];
  closed_reason?: string | null;
};

export async function updateRequirement(
  id: string,
  patch: RequirementPatch,
): Promise<RequirementView> {
  const agent = await requireAgent();
  const before = await requireOwnRequirement(id);

  // Инвариант 2: «в сделке» ставится созданием сделки, а «закрыта» —
  // её закрытием. Руками эти два состояния не выставляются, иначе мандат
  // и подбор разойдутся со сделкой.
  if (patch.status === 'in_deal' && before.status !== 'in_deal') {
    throw new Invalid('Статус «в сделке» ставится созданием сделки из подбора');
  }

  const next: Record<string, string | number | null> = {};
  if (patch.budget_min_minor !== undefined) next.budget_min_minor = patch.budget_min_minor;
  if (patch.budget_max_minor !== undefined) next.budget_max_minor = patch.budget_max_minor;
  if (patch.zones !== undefined)  next.zones = toJson(patch.zones);
  if (patch.rooms !== undefined)  next.rooms = toJson(patch.rooms);
  if (patch.deadline !== undefined) next.deadline = patch.deadline;
  if (patch.requirements_text !== undefined) {
    next.requirements_text = (patch.requirements_text ?? '').trim() || null;
  }
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.closed_reason !== undefined) {
    next.closed_reason = (patch.closed_reason ?? '').trim() || null;
  }

  const min = (next.budget_min_minor ?? before.budget_min_minor) as number | null;
  const max = (next.budget_max_minor ?? before.budget_max_minor) as number | null;
  if (min !== null && max !== null && max < min) {
    throw new Invalid('Верхняя граница бюджета ниже нижней');
  }

  if (Object.keys(next).length === 0) return view(before);

  const at = now();
  const columns = [...Object.keys(next), 'updated_at'];
  const values = [...Object.values(next), at];

  await batch([
    stmt(`update requirements set ${columns.map((c) => `${c} = ?`).join(', ')} where id = ?`,
      ...values, id),
    auditStmt('requirements', id, 'update', agent.id,
      diffOf(before as unknown as Record<string, unknown>, next)),
  ]);

  const updated = await getRequirement(id);
  if (!updated) throw new NotFound('Потребность не найдена');
  return updated;
}

/**
 * Передать потребность коллеге.
 *
 * Вместе с ней уходит и доля комиссии по будущим подборам: closing-агент
 * новых подборов берётся из потребности. Уже созданные подборы не трогаем —
 * работу по ним вёл прежний агент, и переписывать историю нельзя.
 */
export async function transferRequirement(
  id: string,
  toAgentId: string,
): Promise<RequirementView> {
  const agent = await requireAgent();
  const before = await requireOwnRequirement(id);

  const target = await one<{ id: string }>(
    `select id from agents where id = ? and status = 'approved'`, toAgentId,
  );
  if (!target) throw new NotFound('Коллега не найден или не одобрен');
  if (toAgentId === before.agent_id) return view(before);

  const at = now();
  await batch([
    stmt('update requirements set agent_id = ?, updated_at = ? where id = ?',
      toAgentId, at, id),
    auditStmt('requirements', id, 'update', agent.id,
      { agent_id: { from: before.agent_id, to: toAgentId } }),
  ]);

  const row = await getRequirement(id);
  if (!row) throw new NotFound('Потребность не найдена');
  return row;
}
