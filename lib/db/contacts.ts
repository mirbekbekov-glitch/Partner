import 'server-only';
import { all, batch, flag, jsonArray, newId, now, one, stmt, toJson } from './sql';
import { auditStmt } from './audit';
import { isAdmin, requireAgent } from './session';
import { canEditObject, canSeeContact } from './access';
import { normalizePhone, searchText } from './normalize';
import { Conflict, Forbidden, Invalid, NotFound } from './errors';

/**
 * Контакты — инвариант 4 и правило «один человек — одна запись».
 *
 * Уникальность номера держит схема: глобальный индекс по нормализованному
 * виду. Но нормализацию теперь делает код, поэтому здесь единственное
 * место, где пишутся телефоны. Запись мимо него обойдёт нормализацию, и
 * «0700 11 22 33» заживёт отдельно от «+996700112233».
 *
 * Видимость телефона — не свойство страницы, а свойство данных: решает
 * canSeeContact(), и все выдачи ниже спрашивают его, а не рассуждают сами.
 */

export type ContactRow = {
  id: string;
  kind: 'person' | 'company';
  name: string;
  telegram: string | null;
  source: string | null;
  owner_agent_id: string;
  roles: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactView = Omit<ContactRow, 'roles'> & { roles: string[] };

function view(row: ContactRow): ContactView {
  return { ...row, roles: jsonArray<string>(row.roles) };
}

export type PhoneRow = {
  id: string;
  contact_id: string;
  phone: string;
  phone_normalized: string;
  is_primary: number;
  label: string | null;
  created_at: string;
};

export async function getContact(id: string): Promise<ContactView | null> {
  const row = await one<ContactRow>('select * from contacts where id = ?', id);
  return row ? view(row) : null;
}

/**
 * Телефоны контакта — только тому, кому инвариант 4 их открывает.
 *
 * Пустой список вместо отказа намеренно: карточка контакта должна
 * открываться и у того, кому телефон не положен, иначе агент не сможет даже
 * узнать, что запись существует и кем ведётся.
 */
export async function contactPhones(contactId: string): Promise<PhoneRow[]> {
  if (!(await canSeeContact(contactId))) return [];
  return all<PhoneRow>(
    'select * from contact_phones where contact_id = ? order by is_primary desc, created_at',
    contactId,
  );
}

// ---------------------------------------------------------------------------
// Поиск перед созданием
// ---------------------------------------------------------------------------

export type PhoneLookup = {
  found: boolean;
  normalized: string;
  /** Имя коллеги, у которого контакт. Отдаётся всегда, когда контакт найден. */
  owner_name?: string | null;
  visible?: boolean;
  /** Имя и ссылка — только тому, кому контакт и так открыт. */
  contact_id?: string | null;
  name?: string | null;
};

/**
 * Есть ли уже контакт с таким номером.
 *
 * Без этого поиска правило «один человек — одна запись» только наказывало
 * бы за дубликат: агент узнавал бы о существующей записи из ошибки
 * сохранения.
 *
 * Здесь сталкиваются два правила — «одна запись» требует сказать, что
 * контакт есть, а инвариант 4 чужие контакты закрывает. Отдаётся минимум,
 * который решает задачу: факт существования и ИМЯ КОЛЛЕГИ, у которого
 * запись. Имя самого контакта и ссылка на него — только если инвариант 4
 * их и так открывает.
 */
export async function findContactByPhone(phone: string): Promise<PhoneLookup> {
  await requireAgent();

  const normalized = normalizePhone(phone);
  if (normalized === '') return { found: false, normalized };

  const hit = await one<{ id: string; name: string; owner_name: string | null }>(
    `select c.id, c.name, ag.full_name as owner_name
       from contact_phones cp
       join contacts c on c.id = cp.contact_id
       left join agents ag on ag.id = c.owner_agent_id
      where cp.phone_normalized = ? limit 1`,
    normalized,
  );
  if (!hit) return { found: false, normalized };

  const visible = await canSeeContact(hit.id);
  return {
    found: true,
    normalized,
    owner_name: hit.owner_name,
    visible,
    contact_id: visible ? hit.id : null,
    name: visible ? hit.name : null,
  };
}

// ---------------------------------------------------------------------------
// Создание и правка
// ---------------------------------------------------------------------------

export type NewContact = {
  name: string;
  kind?: 'person' | 'company';
  phone?: string | null;
  telegram?: string | null;
  roles?: string[];
  note?: string | null;
  source?: string | null;
};

export async function createContact(input: NewContact): Promise<ContactView> {
  const agent = await requireAgent();

  const name = input.name.trim();
  if (!name) throw new Invalid('Имя обязательно');

  const phone = (input.phone ?? '').trim();
  if (phone) {
    const existing = await findContactByPhone(phone);
    if (existing.found) {
      // Говорим ровно столько, сколько открывает инвариант 4.
      throw new Conflict(
        existing.visible
          ? `Такой номер уже записан за контактом «${existing.name}»`
          : `Такой номер уже есть у коллеги${existing.owner_name ? ': ' + existing.owner_name : ''}`,
      );
    }
  }

  const id = newId();
  const at = now();
  const writes = [
    stmt(
      `insert into contacts (id, kind, name, telegram, source, owner_agent_id,
                             roles, note, search_text, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.kind ?? 'person', name,
      blank(input.telegram), blank(input.source), agent.id,
      toJson(input.roles ?? []), blank(input.note),
      // Поиск идёт по этой колонке, а не по name: lower() в SQLite не
      // приводит кириллицу, и поиск по имени был регистрозависимым.
      searchText(name), at, at,
    ),
    auditStmt('contacts', id, 'insert', agent.id, { name }),
  ];

  if (phone) {
    writes.push(stmt(
      `insert into contact_phones (id, contact_id, phone, phone_normalized,
                                   is_primary, created_at)
       values (?, ?, ?, ?, 1, ?)`,
      newId(), id, phone, normalizePhone(phone), at,
    ));
  }

  await batch(writes);

  const created = await getContact(id);
  if (!created) throw new NotFound('Контакт не сохранился');
  return created;
}

/** Правит свои записи агент, любые — админ. */
async function requireOwnContact(id: string): Promise<ContactRow> {
  const agent = await requireAgent();
  const row = await one<ContactRow>('select * from contacts where id = ?', id);
  if (!row) throw new NotFound('Контакт не найден');

  if (row.owner_agent_id !== agent.id && !(await isAdmin())) {
    throw new Forbidden('Редактировать контакт может тот, кто его ведёт, или администратор');
  }
  return row;
}

export async function updateContact(
  id: string,
  patch: Partial<Pick<NewContact, 'name' | 'kind' | 'telegram' | 'roles' | 'note' | 'source'>>,
): Promise<ContactView> {
  const agent = await requireAgent();
  const before = await requireOwnContact(id);

  const next: Record<string, string | null> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Invalid('Имя обязательно');
    next.name = name;
    // Вместе с именем, в том же наборе колонок: иначе поиск нашёл бы
    // контакт по прежнему имени и не нашёл по новому.
    next.search_text = searchText(name);
  }
  if (patch.kind !== undefined)     next.kind = patch.kind;
  if (patch.telegram !== undefined) next.telegram = blank(patch.telegram);
  if (patch.source !== undefined)   next.source = blank(patch.source);
  if (patch.note !== undefined)     next.note = blank(patch.note);
  if (patch.roles !== undefined)    next.roles = toJson(patch.roles);

  if (Object.keys(next).length === 0) return view(before);

  const at = now();
  const columns = [...Object.keys(next), 'updated_at'];
  const values = [...Object.values(next), at];

  await batch([
    stmt(`update contacts set ${columns.map((c) => `${c} = ?`).join(', ')} where id = ?`,
      ...values, id),
    auditStmt('contacts', id, 'update', agent.id,
      (await import('./audit')).diffOf(before as unknown as Record<string, unknown>, next)),
  ]);

  const updated = await getContact(id);
  if (!updated) throw new NotFound('Контакт не найден');
  return updated;
}

/** Добавить номер. Уникальность проверяется до записи, чтобы отказ был внятным. */
export async function addPhone(
  contactId: string,
  phone: string,
  options: { is_primary?: boolean; label?: string | null } = {},
): Promise<PhoneRow> {
  const agent = await requireAgent();
  await requireOwnContact(contactId);

  const text = phone.trim();
  if (!text) throw new Invalid('Телефон обязателен');

  const normalized = normalizePhone(text);
  if (normalized) {
    const existing = await findContactByPhone(text);
    if (existing.found && existing.contact_id !== contactId) {
      throw new Conflict(
        existing.visible
          ? `Такой номер уже записан за контактом «${existing.name}»`
          : `Такой номер уже есть у коллеги${existing.owner_name ? ': ' + existing.owner_name : ''}`,
      );
    }
  }

  const id = newId();
  const at = now();
  const primary = options.is_primary ?? false;
  const writes = [];

  // Основной номер один на контакт: прежнюю отметку снимаем тем же батчем,
  // иначе уникальный индекс отвергнет вставку.
  if (primary) {
    writes.push(stmt(
      'update contact_phones set is_primary = 0 where contact_id = ? and is_primary = 1',
      contactId,
    ));
  }

  writes.push(stmt(
    `insert into contact_phones (id, contact_id, phone, phone_normalized,
                                 is_primary, label, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    id, contactId, text, normalized, flag(primary), blank(options.label), at,
  ));
  writes.push(auditStmt('contact_phones', id, 'insert', agent.id, { contact_id: contactId }));

  await batch(writes);

  const row = await one<PhoneRow>('select * from contact_phones where id = ?', id);
  if (!row) throw new NotFound('Телефон не сохранился');
  return row;
}

export async function removePhone(phoneId: string): Promise<void> {
  const agent = await requireAgent();

  const phone = await one<PhoneRow>('select * from contact_phones where id = ?', phoneId);
  if (!phone) throw new NotFound('Телефон не найден');
  await requireOwnContact(phone.contact_id);

  await batch([
    stmt('delete from contact_phones where id = ?', phoneId),
    auditStmt('contact_phones', phoneId, 'delete', agent.id,
      { contact_id: phone.contact_id }),
  ]);
}

// ---------------------------------------------------------------------------
// Передача коллеге
// ---------------------------------------------------------------------------

export type TransferReport = {
  contact_id: string;
  contact_name: string;
  requirements: number;
  matches: number;
};

/**
 * Передать контакт другому агенту.
 *
 * Вместе с записью переезжают ЕЁ ОТКРЫТЫЕ ПОТРЕБНОСТИ И ПОДБОРЫ, и это не
 * удобство, а инвариант 3: closing-агент подбора обязан совпадать с агентом
 * потребности, потому что ему идёт половина комиссии. Передать клиента и
 * оставить подборы за прежним агентом значит отдать работу одному, а деньги
 * другому.
 *
 * Порядок важен: сперва потребности, потом подборы — подбор сверяется с УЖЕ
 * новым агентом потребности.
 *
 * Закрытые и проигранные потребности не трогаем: это история, и переписывать
 * её незачем.
 */
export async function transferContact(
  contactId: string,
  toAgentId: string,
): Promise<TransferReport> {
  const agent = await requireAgent();
  const before = await requireOwnContact(contactId);

  const target = await one<{ id: string }>(
    `select id from agents where id = ? and status = 'approved'`, toAgentId,
  );
  if (!target) throw new NotFound('Коллега не найден или не одобрен');

  if (toAgentId === before.owner_agent_id) {
    return {
      contact_id: contactId, contact_name: before.name,
      requirements: 0, matches: 0,
    };
  }

  // Открытая сделка — не повод отказать в передаче контакта: сделку ведут
  // её стороны, и смена владельца записи их не меняет. Считаем до переноса.
  const counts = await one<{ reqs: number; matches: number }>(
    `select
       (select count(*) from requirements r
         where r.contact_id = ?1 and r.status not in ('closed', 'lost')) as reqs,
       (select count(*) from matches m
         where exists (select 1 from requirements r
                        where r.id = m.requirement_id and r.contact_id = ?1
                          and r.status not in ('closed', 'lost'))) as matches`,
    contactId,
  );

  const at = now();
  await batch([
    stmt('update contacts set owner_agent_id = ?, updated_at = ? where id = ?',
      toAgentId, at, contactId),
    stmt(
      `update requirements set agent_id = ?, updated_at = ?
        where contact_id = ? and status not in ('closed', 'lost')`,
      toAgentId, at, contactId,
    ),
    stmt(
      `update matches set closing_agent_id = ?, updated_at = ?
        where exists (select 1 from requirements r
                       where r.id = matches.requirement_id
                         and r.contact_id = ? and r.agent_id = ?)`,
      toAgentId, at, contactId, toAgentId,
    ),
    auditStmt('contacts', contactId, 'update', agent.id, {
      owner_agent_id: { from: before.owner_agent_id, to: toAgentId },
    }),
  ]);

  return {
    contact_id: contactId,
    contact_name: before.name,
    requirements: counts?.reqs ?? 0,
    matches: counts?.matches ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Объединение дубликатов
// ---------------------------------------------------------------------------

export type MergeReport = {
  kept_id: string;
  kept_name: string;
  merged_name: string;
  phones: number;
  ownerships: number;
  ownerships_dropped: number;
  requirements: number;
  activities: number;
};

/**
 * Склеить две записи одного человека.
 *
 * ПОРЯДОК ШАГОВ — не стиль, а защита от потери данных. Ссылки на контакт
 * устроены так:
 *
 *   requirements.contact_id      ON DELETE CASCADE   ← удаление уничтожит
 *   contact_phones.contact_id    ON DELETE CASCADE   ← и телефоны
 *   object_ownerships.contact_id ON DELETE RESTRICT  ← удалить не даст вовсе
 *
 * Поэтому лишняя запись удаляется ПОСЛЕДНЕЙ, когда с неё уже всё снято.
 * Если переставить удаление в начало и у записи НЕТ связей с объектами,
 * RESTRICT промолчит, и потребности исчезнут без единой ошибки. Если связи
 * есть — неправильный порядок упрётся в RESTRICT, то есть поймается
 * случайно. Отсюда и отдельный тест на запись без связей.
 *
 * Объединять можно только СВОИ записи — обе. Иначе объединение становится
 * способом забрать чужого клиента: приписал к своей записи — и он твой,
 * вместе с телефоном и потребностями.
 */
export async function mergeContacts(
  keepId: string,
  mergeId: string,
): Promise<MergeReport> {
  const agent = await requireAgent();

  if (keepId === mergeId) throw new Invalid('Это одна и та же запись');

  const keep = await one<ContactRow>('select * from contacts where id = ?', keepId);
  if (!keep) throw new NotFound('Контакт не найден');
  const merge = await one<ContactRow>('select * from contacts where id = ?', mergeId);
  if (!merge) throw new NotFound('Контакт не найден');

  const admin = await isAdmin();
  if (!admin && !(keep.owner_agent_id === agent.id && merge.owner_agent_id === agent.id)) {
    throw new Forbidden(
      'Объединять можно свои записи — обе. Если дубликат у коллеги, '
      + 'сначала передайте запись друг другу или попросите админа',
    );
  }

  // Считаем до переноса: после него считать уже нечего.
  const counts = await one<{
    phones: number; owns: number; owns_drop: number; reqs: number; acts: number;
  }>(
    `select
       (select count(*) from contact_phones where contact_id = ?1) as phones,
       (select count(*) from object_ownerships oo where oo.contact_id = ?1
          and not exists (select 1 from object_ownerships k
                           where k.object_id = oo.object_id
                             and k.contact_id = ?2 and k.role = oo.role)) as owns,
       (select count(*) from object_ownerships oo where oo.contact_id = ?1
          and exists (select 1 from object_ownerships k
                       where k.object_id = oo.object_id
                         and k.contact_id = ?2 and k.role = oo.role)) as owns_drop,
       (select count(*) from requirements where contact_id = ?1) as reqs,
       (select count(*) from activities
         where entity_type = 'contact' and entity_id = ?1) as acts`,
    mergeId, keepId,
  );

  // Что именно пропадёт из object_ownerships: роль входит в ключ, и если
  // обе записи указаны в одной роли по одному объекту, лишняя снимается.
  // Снимается НАВСЕГДА, поэтому выписываем до удаления — иначе в журнале
  // останется только число «снято: 1», и какая это была связь, не узнать.
  const droppedOwnerships = await all<{ object_id: string; role: string; share: number | null }>(
    `select object_id, role, share from object_ownerships oo
      where oo.contact_id = ?1
        and exists (select 1 from object_ownerships k
                     where k.object_id = oo.object_id
                       and k.contact_id = ?2 and k.role = oo.role)`,
    mergeId, keepId,
  );

  const at = now();
  const roles = [...new Set([
    ...jsonArray<string>(keep.roles), ...jsonArray<string>(merge.roles),
  ])];

  const note = keep.note === null ? merge.note
    : merge.note === null ? keep.note
    : `${keep.note}\n— из объединённой записи «${merge.name}»:\n${merge.note}`;

  await batch([
    // 1. Телефоны. Основной может быть один, поэтому отметку снимаем.
    //    Столкновения по самому номеру быть не может: номер уникален
    //    глобально, значит одинаковых номеров у двух контактов нет.
    stmt('update contact_phones set is_primary = 0 where contact_id = ? and is_primary = 1',
      mergeId),
    stmt('update contact_phones set contact_id = ? where contact_id = ?', keepId, mergeId),
    // Если у остающейся записи основного номера нет, делаем им первый.
    stmt(
      `update contact_phones set is_primary = 1
        where id = (select id from contact_phones where contact_id = ?1
                     order by created_at limit 1)
          and not exists (select 1 from contact_phones
                           where contact_id = ?1 and is_primary = 1)`,
      keepId,
    ),

    // 2. Собственность. Роль входит в ключ: если обе записи указаны в одной
    //    роли по одному объекту, перенос упёрся бы в него — лишнюю снимаем.
    stmt(
      `delete from object_ownerships where contact_id = ?1
        and exists (select 1 from object_ownerships k
                     where k.object_id = object_ownerships.object_id
                       and k.contact_id = ?2
                       and k.role = object_ownerships.role)`,
      mergeId, keepId,
    ),
    stmt('update object_ownerships set contact_id = ? where contact_id = ?', keepId, mergeId),

    // 3. Потребности. Ведущий агент НЕ меняется: кто вёл, тот и ведёт.
    //    Поэтому правило «closing-агент подбора = агент потребности» не
    //    затронуто и подборы двигать не нужно.
    stmt('update requirements set contact_id = ? where contact_id = ?', keepId, mergeId),

    // 4. Активности.
    stmt(
      `update activities set entity_id = ?
        where entity_type = 'contact' and entity_id = ?`,
      keepId, mergeId,
    ),

    // 5. Поля самой записи: роли складываются, пустое заполняется, заметки
    //    склеиваются — терять написанное человеком незачем.
    stmt(
      `update contacts set roles = ?, telegram = coalesce(telegram, ?),
                           source = coalesce(source, ?), note = ?, updated_at = ?
        where id = ?`,
      toJson(roles), merge.telegram, merge.source, note, at, keepId,
    ),

    // 6. И только теперь удаляем: всё снято, CASCADE нечего уносить,
    //    RESTRICT не мешает.
    stmt('delete from contacts where id = ?', mergeId),

    auditStmt('contacts', keepId, 'update', agent.id, {
      merged_from: { from: mergeId, to: keepId },
    }),
    // Присоединённая запись удаляется, и вернуть её нечем: отмены у
    // объединения нет. Значит журнал — единственное место, где её
    // содержимое вообще остаётся, и писать туда одно имя мало. Здесь
    // лежит всё, из чего запись можно собрать руками: вид, telegram,
    // источник, роли, заметка, владелец и когда она появилась.
    //
    // Телефонов здесь нет намеренно, и это не пропуск: они не удаляются,
    // а переезжают к остающейся записи. Общее правило журнала — не
    // складывать в него телефоны при каждой правке — остаётся в силе.
    auditStmt('contacts', mergeId, 'delete', agent.id, {
      name: merge.name,
      kind: merge.kind,
      telegram: merge.telegram,
      source: merge.source,
      roles: jsonArray<string>(merge.roles),
      note: merge.note,
      owner_agent_id: merge.owner_agent_id,
      created_at: merge.created_at,
      merged_into: keepId,
      dropped_ownerships: droppedOwnerships,
    }),
  ]);

  return {
    kept_id: keepId,
    kept_name: keep.name,
    merged_name: merge.name,
    phones: counts?.phones ?? 0,
    ownerships: counts?.owns ?? 0,
    ownerships_dropped: counts?.owns_drop ?? 0,
    requirements: counts?.reqs ?? 0,
    activities: counts?.acts ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Собственность объекта
// ---------------------------------------------------------------------------

/**
 * Связать контакт с объектом.
 *
 * Связь собственности — ОСНОВАНИЕ ДОСТУПА, а не пометка: именно на неё
 * опирается инвариант 4 для участников сделки. Поэтому и права здесь
 * двойные: нужно и отвечать за объект, и иметь доступ к контакту.
 *
 * Смена роли — это перенос, а не правка поля: роль входит в составной ключ,
 * и наивное обновление оставило бы у человека две роли вместо одной.
 */
export async function setObjectOwnership(
  objectId: string,
  contactId: string,
  role: 'owner' | 'co_owner' | 'proxy' | 'contact_person',
  share: number | null = null,
): Promise<void> {
  const agent = await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Связать контакт с объектом может тот, кто за объект отвечает');
  }
  if (!(await canSeeContact(contactId))) {
    throw new Forbidden('Этот контакт вам не доступен');
  }
  if (share !== null && (share <= 0 || share > 1)) {
    throw new Invalid('Доля задаётся числом от 0 до 1 — например 0.5 для половины');
  }

  // Сумма долей не выходит за единицу. Это межстрочное правило, поэтому
  // проверка здесь, а не в CHECK: CHECK видит только свою строку. Пустая
  // доля означает «неизвестна» и в сумму не идёт.
  if (share !== null) {
    const sum = await one<{ total: number }>(
      `select coalesce(sum(share), 0) as total from object_ownerships
        where object_id = ? and share is not null
          and not (contact_id = ? and role = ?)`,
      objectId, contactId, role,
    );
    if ((sum?.total ?? 0) + share > 1) {
      throw new Conflict(
        `Сумма долей по объекту вышла бы за единицу: ${(sum?.total ?? 0) + share}. `
        + 'Доля это основание для раздела комиссии, а не пометка — уменьшите доли '
        + 'других собственников или оставьте долю пустой, если она неизвестна.',
      );
    }
  }

  const at = now();
  await batch([
    // Прежние роли этого контакта по этому объекту убираем: у человека по
    // одному объекту одна роль, а не набор.
    stmt(
      'delete from object_ownerships where object_id = ? and contact_id = ? and role <> ?',
      objectId, contactId, role,
    ),
    stmt(
      `insert into object_ownerships (object_id, contact_id, role, share, created_at)
       values (?, ?, ?, ?, ?)
       on conflict (object_id, contact_id, role) do update set share = excluded.share`,
      objectId, contactId, role, share, at,
    ),
    auditStmt('object_ownerships', objectId, 'update', agent.id,
      { contact_id: contactId, role, share }),
  ]);
}

/**
 * Снять связь.
 *
 * Пока по объекту идёт сделка, он НЕ МОЖЕТ остаться без собственника.
 * Измерено на прежней схеме: снятие связи при открытой сделке отбирало у
 * closing-агента телефон собственника — видел 1, стало 0, — а сделка шла
 * дальше в статусе «аванс». Причём сделать это мог другой участник
 * в одиночку.
 *
 * Правило поэтому узкое: добавлять собственников во время сделки можно
 * свободно (это только расширяет доступ), а исправить ошибочно указанного
 * по-прежнему можно — сначала добавить верного, потом снять неверного, и
 * объект ни на миг не остаётся без стороны.
 */
export async function removeObjectOwnership(
  objectId: string,
  contactId: string,
  role: string,
): Promise<void> {
  const agent = await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Снять связь может тот, кто за объект отвечает');
  }

  const rest = await one<{ n: number }>(
    `select count(*) as n from object_ownerships
      where object_id = ? and not (contact_id = ? and role = ?)`,
    objectId, contactId, role,
  );

  if ((rest?.n ?? 0) === 0) {
    const deal = await one<{ id: string }>(
      `select id from deals where object_id = ? and status not in ('closed', 'failed')`,
      objectId,
    );
    if (deal) {
      throw new Conflict(
        'Пока по объекту идёт сделка, он не может остаться без собственника. '
        + 'Сначала добавьте верного собственника, потом снимите неверного.',
      );
    }
  }

  await batch([
    stmt(
      'delete from object_ownerships where object_id = ? and contact_id = ? and role = ?',
      objectId, contactId, role,
    ),
    auditStmt('object_ownerships', objectId, 'delete', agent.id,
      { contact_id: contactId, role }),
  ]);
}

function blank(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}
