import 'server-only';
import { all, batch, flag, newId, now, one, stmt } from './sql';
import { auditStmt } from './audit';
import { requireAdmin, requireAgent, type Agent } from './session';
import { normalizeName } from './normalize';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Агенты и агентства.
 *
 * Главное правило модуля: АГЕНТ НЕ МОЖЕТ ПОВЫСИТЬ СЕБЯ. В Postgres это
 * держал поколоночный грант плюс триггер — политика «правь свои строки»
 * означала «правь любую колонку своих строк», и агент мог выписать себе
 * status = 'approved', role = 'admin'.
 *
 * Здесь колонок не выдают никому: правка профиля (updateProfile) трогает
 * только имя и телефон, а статус, роль и агентство меняют отдельные
 * функции, каждая со своей проверкой. Поля status, role, email и
 * organization_id не принимаются этим модулем ниоткуда, кроме админских
 * действий.
 */

export type AgentRow = Agent;

export async function getAgent(id: string): Promise<AgentRow | null> {
  return one<AgentRow>('select * from agents where id = ?', id);
}

/**
 * Список агентов для экрана админа.
 *
 * requireAdmin() стоит первой строкой, и это единственная защита: раньше
 * экран опирался на представление с «where app.is_admin()» внутри, и не
 * админу оно просто ничего не отдавало. Теперь такой подстраховки нет.
 *
 * Счётчики рядом с именем — чтобы перед блокировкой было видно, что за
 * агентом записано: блокировка ничего не удаляет, но админ должен понимать
 * объём.
 */
export async function listAgents(): Promise<Array<AgentRow & {
  organization_name: string | null;
  objects_count: number;
  contacts_count: number;
  requirements_count: number;
}>> {
  await requireAdmin();
  return all(
    `select a.*, o.name as organization_name,
            (select count(*) from objects x where x.created_by_agent_id = a.id)
              as objects_count,
            (select count(*) from contacts x where x.owner_agent_id = a.id)
              as contacts_count,
            (select count(*) from requirements x where x.agent_id = a.id)
              as requirements_count
       from agents a left join organizations o on o.id = a.organization_id
      order by case a.status when 'pending' then 0 when 'approved' then 1 else 2 end,
               a.created_at desc`,
  );
}

/** Одобренные коллеги — для передачи клиента или объекта. */
export async function approvedColleagues(): Promise<Array<{ id: string; full_name: string }>> {
  const agent = await requireAgent();
  return all(
    `select id, full_name from agents
      where status = 'approved' and id <> ? order by full_name`,
    agent.id,
  );
}

// ---------------------------------------------------------------------------
// Вход: своя строка агента
// ---------------------------------------------------------------------------

/**
 * Найти или завести агента по почте — инвариант 6.
 *
 * Якорь личности теперь почта, а не Telegram: вход идёт по ссылке на неё.
 * Повторный вход НЕ создаёт вторую строку, поэтому всё, что записано за
 * агентом — объекты, мандаты, подборы, — остаётся при нём.
 *
 * Новый агент рождается со статусом «ожидает»: кабинет ему не открыт, пока
 * админ не одобрит. Первого админа система себе назначить не может — это
 * продолжение того же правила, и заводится он прямым доступом к базе.
 */
export async function ensureAgentByEmail(
  email: string,
  fullName?: string | null,
): Promise<AgentRow> {
  const clean = email.trim().toLowerCase();
  if (!clean) throw new Invalid('Почта обязательна');

  const at = now();
  const existing = await one<AgentRow>('select * from agents where email = ?', clean);

  if (existing) {
    const name = (fullName ?? '').trim();
    if (name && name !== existing.full_name) {
      await batch([
        stmt('update agents set full_name = ?, updated_at = ? where id = ?',
          name, at, existing.id),
        auditStmt('agents', existing.id, 'update', existing.id,
          { full_name: { from: existing.full_name, to: name } }),
      ]);
      return { ...existing, full_name: name };
    }
    return existing;
  }

  // Имени ещё нет — осмысленное значение по умолчанию это сама почта.
  const id = newId();
  const name = (fullName ?? '').trim() || clean;

  await batch([
    stmt(
      `insert into agents (id, email, full_name, role, status, focus,
                           created_at, updated_at)
       values (?, ?, ?, 'agent', 'pending', 'both', ?, ?)`,
      id, clean, name, at, at,
    ),
    auditStmt('agents', id, 'insert', null, { email: clean }),
  ]);

  const created = await getAgent(id);
  if (!created) throw new NotFound('Агент не сохранился');
  return created;
}

/** Правка профиля. Трогает ровно два поля — и в этом весь смысл функции. */
export async function updateProfile(
  patch: { full_name?: string; phone?: string | null; focus?: 'sale' | 'rent' | 'both' },
): Promise<AgentRow> {
  const agent = await requireAgent();

  const next: Record<string, string | null> = {};
  if (patch.full_name !== undefined) {
    const name = patch.full_name.trim();
    if (!name) throw new Invalid('Имя обязательно');
    next.full_name = name;
  }
  if (patch.phone !== undefined) next.phone = (patch.phone ?? '').trim() || null;
  if (patch.focus !== undefined) next.focus = patch.focus;

  if (Object.keys(next).length === 0) return agent;

  const at = now();
  const columns = [...Object.keys(next), 'updated_at'];

  await batch([
    stmt(`update agents set ${columns.map((c) => `${c} = ?`).join(', ')} where id = ?`,
      ...Object.values(next), at, agent.id),
    auditStmt('agents', agent.id, 'update', agent.id, next),
  ]);

  const row = await getAgent(agent.id);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

// ---------------------------------------------------------------------------
// Действия админа
// ---------------------------------------------------------------------------

/**
 * Последнего админа нельзя ни заблокировать, ни разжаловать.
 *
 * Иначе систему можно запереть так, что одобрять новых агентов станет
 * некому, и починить это изнутри будет нечем.
 */
async function assertAdminRemains(exceptId: string): Promise<void> {
  const other = await one<{ id: string }>(
    `select id from agents where role = 'admin' and status = 'approved' and id <> ?`,
    exceptId,
  );
  if (!other) {
    throw new Conflict('Это последний админ, одобрять агентов станет некому');
  }
}

export async function approveAgent(agentId: string): Promise<AgentRow> {
  const admin = await requireAdmin();

  const target = await getAgent(agentId);
  if (!target) throw new NotFound('Агент не найден');

  const at = now();
  await batch([
    stmt(`update agents set status = 'approved', updated_at = ? where id = ?`, at, agentId),
    auditStmt('agents', agentId, 'update', admin.id,
      { status: { from: target.status, to: 'approved' } }),
  ]);

  const row = await getAgent(agentId);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

export async function blockAgent(agentId: string): Promise<AgentRow> {
  const admin = await requireAdmin();

  const target = await getAgent(agentId);
  if (!target) throw new NotFound('Агент не найден');

  if (target.role === 'admin' && target.status === 'approved') {
    await assertAdminRemains(agentId);
  }

  const at = now();
  await batch([
    stmt(`update agents set status = 'blocked', updated_at = ? where id = ?`, at, agentId),
    auditStmt('agents', agentId, 'update', admin.id,
      { status: { from: target.status, to: 'blocked' } }),
    // Заблокированный агент не должен доработать смену по старой cookie.
    stmt('delete from sessions where agent_id = ?', agentId),
  ]);

  const row = await getAgent(agentId);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

export async function setAgentRole(
  agentId: string,
  role: 'agent' | 'admin',
): Promise<AgentRow> {
  const admin = await requireAdmin();

  const target = await getAgent(agentId);
  if (!target) throw new NotFound('Агент не найден');

  if (role !== 'admin') await assertAdminRemains(agentId);

  const at = now();
  await batch([
    stmt('update agents set role = ?, updated_at = ? where id = ?', role, at, agentId),
    auditStmt('agents', agentId, 'update', admin.id,
      { role: { from: target.role, to: role } }),
  ]);

  const row = await getAgent(agentId);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

/**
 * Привязать Telegram агенту.
 *
 * Делает это админ: самостоятельная привязка требует подтверждения через
 * бота, которого здесь нет. Без неё напоминания агенту доставить нечем, и
 * он видит это в списке задач как «нечем доставить».
 */
export async function setAgentTelegram(
  agentId: string,
  telegramId: number | null,
): Promise<AgentRow> {
  const admin = await requireAdmin();

  const target = await getAgent(agentId);
  if (!target) throw new NotFound('Агент не найден');

  if (telegramId !== null) {
    const taken = await one<{ id: string }>(
      'select id from agents where telegram_id = ? and id <> ?', telegramId, agentId,
    );
    if (taken) throw new Conflict('Этот Telegram уже привязан к другому агенту');
  }

  const at = now();
  await batch([
    stmt('update agents set telegram_id = ?, updated_at = ? where id = ?',
      telegramId, at, agentId),
    auditStmt('agents', agentId, 'update', admin.id, { telegram_id: telegramId }),
  ]);

  const row = await getAgent(agentId);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

// ---------------------------------------------------------------------------
// Агентства
// ---------------------------------------------------------------------------

export type OrganizationRow = {
  id: string;
  name: string;
  name_normalized: string;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function listOrganizations(): Promise<OrganizationRow[]> {
  return all<OrganizationRow>('select * from organizations order by name');
}

/**
 * Указать своё агентство.
 *
 * Агент ЗАЯВЛЯЕТ агентство, но не подтверждает его: иначе любой впишет
 * «Этажи» и прикроется чужой репутацией. Поэтому org_confirmed здесь
 * всегда сбрасывается в ноль, а поднять его может только админ.
 *
 * Название уникально по нормализованному виду — иначе «Этажи», «этажи» и
 * «ЭТАЖИ» станут тремя агентствами, фильтр по источнику развалится, а
 * сводить их придётся руками.
 *
 * Частный агент — это ОТСУТСТВИЕ организации, а не агентство с названием
 * «Частный агент»: иначе такие агенты склеились бы в одно несуществующее
 * агентство.
 */
export async function setMyOrganization(name: string): Promise<AgentRow> {
  const agent = await requireAgent();

  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) {
    throw new Invalid('Название агентства — от 2 до 120 символов');
  }

  const normalized = normalizeName(clean);
  const at = now();

  let orgId: string;
  const existing = await one<OrganizationRow>(
    'select * from organizations where name_normalized = ?', normalized,
  );

  const writes = [];
  if (existing) {
    orgId = existing.id;
  } else {
    orgId = newId();
    writes.push(stmt(
      `insert into organizations (id, name, name_normalized, created_by_agent_id,
                                  created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      orgId, clean, normalized, agent.id, at, at,
    ));
    writes.push(auditStmt('organizations', orgId, 'insert', agent.id, { name: clean }));
  }

  writes.push(stmt(
    `update agents set organization_id = ?, org_confirmed = 0, updated_at = ?
      where id = ?`,
    orgId, at, agent.id,
  ));
  writes.push(auditStmt('agents', agent.id, 'update', agent.id,
    { organization_id: { from: agent.organization_id, to: orgId } }));

  await batch(writes);

  const row = await getAgent(agent.id);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

/** Уйти из агентства. Снять подтверждение может и сам агент: это не повышение прав. */
export async function clearMyOrganization(): Promise<AgentRow> {
  const agent = await requireAgent();
  const at = now();

  await batch([
    stmt(`update agents set organization_id = null, org_confirmed = 0, updated_at = ?
           where id = ?`, at, agent.id),
    auditStmt('agents', agent.id, 'update', agent.id,
      { organization_id: { from: agent.organization_id, to: null } }),
  ]);

  const row = await getAgent(agent.id);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

/** Подтвердить принадлежность к агентству — только админ. */
export async function confirmAgentOrganization(
  agentId: string,
  confirmed: boolean,
): Promise<AgentRow> {
  const admin = await requireAdmin();

  const target = await getAgent(agentId);
  if (!target) throw new NotFound('Агент не найден');
  if (!target.organization_id) {
    throw new Invalid('У агента не указано агентство — подтверждать нечего');
  }

  const at = now();
  await batch([
    stmt('update agents set org_confirmed = ?, updated_at = ? where id = ?',
      flag(confirmed), at, agentId),
    auditStmt('agents', agentId, 'update', admin.id, { org_confirmed: confirmed }),
  ]);

  const row = await getAgent(agentId);
  if (!row) throw new NotFound('Агент не найден');
  return row;
}

export { Forbidden };
