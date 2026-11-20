import { asAgent } from "./db";
import { readSession } from "./session";

/**
 * Данные кабинета.
 *
 * Каждый запрос идёт под ролью `authenticated` с клеймами вошедшего, поэтому
 * «свои объекты» и «чужие контакты» решает не условие в запросе, а построчная
 * политика в базе. Запрос здесь может быть написан неправильно — чужого он
 * всё равно не достанет.
 */

export type Me = {
  id: string;
  full_name: string;
  phone: string;
  role: "agent" | "admin";
  status: "pending" | "approved" | "blocked";
  is_admin: boolean;
};

export type CabinetObject = {
  id: string;
  kind: string;
  deal_type: string;
  address: string;
  zone: string | null;
  rooms: number | null;
  area: string | null;
  price: string;
  currency: string;
  publication_state: string;
  actual_at: Date | string | null;
  published_at: Date | string | null;
  photos_count: number;
  mandate_status: string | null;
  mandate_valid_to: Date | string | null;
  contract_confirmed: boolean | null;
  is_mine: boolean;
  stale_reasons: string[] | null;
  severity: string | null;
  attention: number;
};

/** Кто вошёл. null означает «входа нет»: сессии нет или она просрочена. */
export async function me(): Promise<Me | null> {
  const session = await readSession();
  if (!session) return null;

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<Me>(
      `select id, full_name, phone, role, status, is_admin from me_v`,
    );
    return rows[0] ?? null;
  });
}

/**
 * Объекты агента. Не «все объекты с фильтром по агенту»: политика отдаёт
 * агенту его объекты и объекты агентства, и отличать своё от чужого —
 * работа столбца `is_mine`, а не оговорки в условии.
 */
export async function myObjects(): Promise<CabinetObject[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<CabinetObject>(
      `select
         o.id, o.kind::text, o.deal_type::text, o.address, o.zone, o.rooms,
         o.area::text, o.price::text, o.currency,
         o.publication_state::text, o.actual_at, o.published_at,
         (select count(*) from object_photos p where p.object_id = o.id)::int as photos_count,
         m.status::text  as mandate_status,
         m.valid_to      as mandate_valid_to,
         m.contract_confirmed,
         (o.created_by_agent_id = app.current_agent_id()) as is_mine,
         s.reasons       as stale_reasons,
         s.severity::text as severity,
         -- Что требует действия агента. Это НЕ определение подвисшего
         -- объекта: оно живёт в stale_objects_v и шире сюда не лезет.
         -- Здесь порядок рабочего экрана, и он должен совпадать с тем,
         -- что обещано в заголовке списка, иначе обещание — украшение.
         case
           when s.severity = 'critical'                        then 0
           when m.id is null                                   then 1
           when m.contract_confirmed is not true               then 2
           when o.publication_state = 'published'
                and not exists (select 1 from object_photos p
                                 where p.object_id = o.id)     then 3
           when s.severity is not null                         then 4
           else 9
         end as attention
       from objects o
       left join mandates m
         on m.object_id = o.id and m.status = 'active'
       left join stale_objects_v s on s.object_id = o.id
       order by
         (o.created_by_agent_id = app.current_agent_id()) desc,
         attention asc,
         o.actual_at asc nulls first`,
    );
    return rows;
  });
}

export type Inquiry = {
  id: string;
  intent: string;
  status: string;
  channel: string;
  source: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  body: string | null;
  received_at: Date | string;
  age_hours: number;
  received_by_name: string | null;
  about_object_address: string | null;
  rejection_reason: string | null;
};

export async function inquiries(): Promise<Inquiry[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<Inquiry>(
      `select id, intent::text, status::text, channel::text, source,
              contact_name, contact_phone, body, received_at,
              round(extract(epoch from (now() - received_at)) / 3600)::int as age_hours,
              received_by_name, about_object_address, rejection_reason
         from inquiries_v
        order by
          -- Необработанные первыми: это очередь, а не журнал.
          case status when 'new' then 0 when 'qualified' then 1 else 2 end,
          received_at asc`,
    );
    return rows;
  });
}

export type Candidate = {
  id: string;
  source: string;
  title: string | null;
  address: string | null;
  zone: string | null;
  kind: string | null;
  deal_type: string | null;
  rooms: number | null;
  area: string | null;
  price: string | null;
  currency: string;
  url: string | null;
  status: string;
  author: string;
  last_seen_at: Date | string;
  claimed_until: Date | string | null;
  claimed_by_me: boolean;
  phone: string | null;
};

export async function candidates(): Promise<Candidate[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<Candidate>(
      `select c.id, c.source::text, c.title, c.address, c.zone,
              c.kind::text, c.deal_type::text, c.rooms, c.area::text,
              c.price::text, c.currency, c.url, c.status::text,
              c.author::text, c.last_seen_at, c.claimed_until,
              (c.claimed_by_agent_id = app.current_agent_id()) as claimed_by_me,
              -- Телефон отдаёт политика, а не этот запрос: взявшему агенту
              -- строка видна, остальным её нет (инвариант 12).
              (select ph.phone from listing_candidate_phones ph
                where ph.candidate_id = c.id) as phone
         from listing_candidates c
        where c.status in ('new', 'in_work')
          and c.author <> 'agent'
        order by
          (c.claimed_by_agent_id = app.current_agent_id()) desc nulls last,
          c.last_seen_at desc
        limit 100`,
    );
    return rows;
  });
}

export type AgencyAgent = {
  id: string;
  full_name: string;
  phone: string;
  role: string;
  status: string;
  created_at: Date | string;
  objects_total: number;
  mandates_active: number;
  deals_closed: number;
};

export async function agencyAgents(): Promise<AgencyAgent[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<AgencyAgent>(`select * from agency_agents_v`);
    return rows;
  });
}

export type SchedulerJob = {
  job: string;
  description: string;
  status: string;
  cron_expression: string;
  silence: string | null;
  last_error: string | null;
};

export async function schedulerHealth(): Promise<SchedulerJob[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<SchedulerJob>(
      `select job, description, status, cron_expression,
              date_trunc('minute', silence)::text as silence, last_error
         from maintenance_health_v
        order by (status <> 'в норме') desc, job`,
    );
    return rows;
  });
}

/** Сводка для главной страницы кабинета. Один запрос, а не пять. */
export type Summary = {
  objects_mine: number;
  objects_published: number;
  stale_critical: number;
  inquiries_new: number;
  candidates_mine: number;
  showings_upcoming: number;
  requirements_mine: number;
  agents_pending: number;
  scheduler_broken: number;
};

export async function summary(): Promise<Summary | null> {
  const session = await readSession();
  if (!session) return null;

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<Summary>(
      `select
         (select count(*) from objects o
           where o.created_by_agent_id = app.current_agent_id())::int as objects_mine,
         (select count(*) from objects o
           where o.created_by_agent_id = app.current_agent_id()
             and o.publication_state = 'published')::int               as objects_published,
         (select count(*) from stale_objects_v s
           where s.severity = 'critical')::int                         as stale_critical,
         (select count(*) from inquiries_v i
           where i.status = 'new')::int                                as inquiries_new,
         (select count(*) from listing_candidates c
           where c.claimed_by_agent_id = app.current_agent_id()
             and c.status = 'in_work')::int                            as candidates_mine,
         (select count(*) from showings_v sh
           where sh.status = 'scheduled' and sh.scheduled_at > now())::int as showings_upcoming,
         (select count(*) from requirements rq
           where rq.agent_id = app.current_agent_id()
             and rq.status in ('new', 'qualified', 'in_showings'))::int as requirements_mine,
         (select count(*) from agents a where a.status = 'pending')::int as agents_pending,
         (select count(*) from maintenance_health_v h
           where h.enabled and h.status <> 'в норме')::int             as scheduler_broken`,
    );
    return rows[0] ?? null;
  });
}

export type ObjectDetail = {
  object: CabinetObject & { description: string | null };
  photos: {
    storage_key: string;
    sort_order: number;
    width: number | null;
    height: number | null;
    byte_size: number | null;
    is_cover: boolean;
  }[];
  // Право на правку фотографий — не свойство экрана: фотографии ведёт
  // listing-агент действующего мандата (инвариант 11), и кнопки показываются
  // ровно тому, кому база разрешит действие.
  canEditPhotos: boolean;
  photoLimit: number;
  owners: { contact_id: string; name: string; phones: string[]; share: string | null; role: string }[];
  matches: { match_id: string; requirement_id: string; client_name: string | null; match_status: string }[];
  showings: { id: string; scheduled_at: string; status: string; outcome: string | null; agent_name: string | null }[];
  ownerLinks: { contact_id: string; name: string; token: string; expires_at: Date | string; view_count: number }[];
};

/**
 * Один объект со всем, что к нему относится.
 *
 * Телефон собственника здесь не «скрывается на экране»: если агент его видеть
 * не должен, строка не придёт из базы вовсе (инвариант 4). Поэтому пустой
 * список телефонов — это ответ, а не ошибка запроса.
 */
export async function objectDetail(id: string): Promise<ObjectDetail | null> {
  const session = await readSession();
  if (!session) return null;

  return asAgent(session, "read only", async (db) => {
    const { rows: objectRows } = await db.query(
      `select o.id, o.kind::text, o.deal_type::text, o.address, o.zone, o.rooms,
              o.area::text, o.price::text, o.currency, o.description,
              o.publication_state::text, o.actual_at, o.published_at,
              (select count(*) from object_photos p where p.object_id = o.id)::int as photos_count,
              m.status::text as mandate_status, m.valid_to as mandate_valid_to,
              m.contract_confirmed,
              (o.created_by_agent_id = app.current_agent_id()) as is_mine,
              s.reasons as stale_reasons, s.severity::text as severity
         from objects o
         left join mandates m on m.object_id = o.id and m.status = 'active'
         left join stale_objects_v s on s.object_id = o.id
        where o.id = $1`,
      [id],
    );
    if (objectRows.length === 0) return null;

    const [photos, owners, matches, showings, links] = await Promise.all([
      db.query(
        `select storage_key, sort_order, width, height, byte_size, is_cover
           from cabinet_photo_v where object_id = $1 order by sort_order`,
        [id],
      ),
      db.query(
        `select c.id as contact_id, c.name, oo.share::text as share, oo.role::text,
                coalesce(array_agg(cp.phone order by cp.is_primary desc)
                           filter (where cp.phone is not null), '{}') as phones
           from object_ownerships oo
           join contacts c on c.id = oo.contact_id
           left join contact_phones cp on cp.contact_id = c.id
          where oo.object_id = $1
          group by c.id, c.name, oo.share, oo.role`,
        [id],
      ),
      db.query(
        `select match_id, requirement_id, client_name, match_status::text
           from object_matches_v where object_id = $1 limit 20`,
        [id],
      ),
      db.query(
        `select id, scheduled_at, status::text, outcome::text, agent_name
           from showings_v where object_id = $1
          order by scheduled_at desc limit 20`,
        [id],
      ),
      db.query(
        `select oa.contact_id, c.name, oa.token, oa.expires_at, oa.view_count
           from owner_access oa
           join contacts c on c.id = oa.contact_id
          where oa.object_id = $1 and oa.revoked_at is null
            and oa.expires_at > now()`,
        [id],
      ),
    ]);

    const { rows: rights } = await db.query<{ can_edit: boolean; limit: number }>(
      `select
         exists (select 1 from mandates m
                  where m.object_id = $1 and m.status = 'active'
                    and (m.listing_agent_id = app.current_agent_id()
                         or app.is_admin())) as can_edit,
         app.max_photos_per_object() as limit`,
      [id],
    );

    return {
      object: objectRows[0] as ObjectDetail["object"],
      photos: photos.rows as ObjectDetail["photos"],
      canEditPhotos: rights[0].can_edit,
      photoLimit: rights[0].limit,
      owners: owners.rows as ObjectDetail["owners"],
      matches: matches.rows as ObjectDetail["matches"],
      showings: showings.rows as ObjectDetail["showings"],
      ownerLinks: links.rows as ObjectDetail["ownerLinks"],
    };
  });
}

export type ContactOption = { id: string; name: string; phone: string | null };

/** Собственники, которых агент уже знает. Для выпадающего списка при заведении. */
export async function myContacts(): Promise<ContactOption[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<ContactOption>(
      `select c.id, c.name,
              (select cp.phone from contact_phones cp
                where cp.contact_id = c.id
                order by cp.is_primary desc limit 1) as phone
         from contacts c
        where 'owner' = any (c.roles)
        order by c.name
        limit 200`,
    );
    return rows;
  });
}

export type CandidateDraft = {
  id: string;
  source: string;
  kind: string | null;
  deal_type: string | null;
  address: string | null;
  zone: string | null;
  rooms: number | null;
  area: string | null;
  floor: number | null;
  floors_total: number | null;
  price: string | null;
  currency: string;
  description: string | null;
  phone: string | null;
};

/**
 * Объявление, из которого заводится объект.
 *
 * Телефон отдаёт политика, а не этот запрос: он виден только взявшему
 * агенту (инвариант 12). Если объявление не за этим агентом, поле придёт
 * пустым — и это правильный ответ, а не недосмотр.
 */
export async function candidateForObject(id: string): Promise<CandidateDraft | null> {
  const session = await readSession();
  if (!session) return null;

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<CandidateDraft>(
      `select c.id, c.source::text, c.kind::text, c.deal_type::text,
              coalesce(c.address, c.title) as address, c.zone,
              c.rooms,
              trim(trailing '.' from trim(trailing '0' from c.area::text)) as area,
              c.floor, c.floors_total,
              -- Без хвоста «.00»: это поле ввода, а не отчёт.
              trim(trailing '.' from trim(trailing '0' from c.price::text)) as price,
              c.currency, c.description,
              (select ph.phone from listing_candidate_phones ph
                where ph.candidate_id = c.id) as phone
         from listing_candidates c
        where c.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
}

export type Requirement = {
  id: string;
  client_name: string | null;
  client_phone: string | null;
  deal_type: string;
  budget_min: string | null;
  budget_max: string | null;
  zones: string[];
  rooms: number[];
  deadline: Date | string | null;
  requirements_text: string | null;
  status: string;
  created_at: Date | string;
  is_mine: boolean;
  agent_name: string | null;
  matches_total: number;
  showings_total: number;
};

/**
 * Потребности клиентов. Свои первыми: подбор по чужой потребности база всё
 * равно не даст (инвариант 20), и мешать их в одну кучу незачем.
 */
export async function requirements(): Promise<Requirement[]> {
  const session = await readSession();
  if (!session) return [];

  return asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<Requirement>(
      `select r.id, c.name as client_name,
              (select cp.phone from contact_phones cp
                where cp.contact_id = c.id order by cp.is_primary desc limit 1) as client_phone,
              r.deal_type::text, r.budget_min::text, r.budget_max::text,
              r.zones, r.rooms::int[], r.deadline, r.requirements_text,
              r.status::text, r.created_at,
              (r.agent_id = app.current_agent_id()) as is_mine,
              a.full_name as agent_name,
              (select count(*) from matches m where m.requirement_id = r.id)::int as matches_total,
              (select count(*) from showings sh
                 join matches m on m.id = sh.match_id
                where m.requirement_id = r.id)::int as showings_total
         from requirements r
         left join contacts c on c.id = r.contact_id
         left join agents a on a.id = r.agent_id
        order by
          (r.agent_id = app.current_agent_id()) desc,
          case r.status when 'new' then 0 when 'qualified' then 1
                        when 'in_showings' then 2 when 'in_deal' then 3 else 4 end,
          r.created_at desc`,
    );
    return rows;
  });
}

export type MatchCandidate = {
  object_id: string;
  address: string;
  kind: string;
  zone: string | null;
  rooms: number | null;
  area: string | null;
  floor: number | null;
  floors_total: number | null;
  price: string;
  currency: string;
  actual_at: Date | string;
  publication_state: string;
  photos_count: number;
  listing_agent: string | null;
  is_mine: boolean;
  fit: string;
  already_proposed: boolean;
};

export type ProposedMatch = {
  match_id: string;
  object_id: string;
  address: string;
  price: string;
  currency: string;
  match_status: string;
  showing_at: Date | string | null;
  rejection_reason: string | null;
  commission_total: string | null;
  closing_share: string | null;
  deal_id: string | null;
  deal_status: string | null;
};

export type RequirementDetail = {
  requirement: Requirement;
  candidates: MatchCandidate[];
  proposed: ProposedMatch[];
  showings: {
    id: string;
    match_id: string;
    address: string;
    scheduled_at: Date | string;
    status: string;
    outcome: string | null;
    client_reaction: string | null;
  }[];
};

export async function requirementDetail(id: string): Promise<RequirementDetail | null> {
  const session = await readSession();
  if (!session) return null;

  return asAgent(session, "read only", async (db) => {
    const { rows: reqRows } = await db.query<Requirement>(
      `select r.id, c.name as client_name,
              (select cp.phone from contact_phones cp
                where cp.contact_id = c.id order by cp.is_primary desc limit 1) as client_phone,
              r.deal_type::text, r.budget_min::text, r.budget_max::text,
              r.zones, r.rooms::int[], r.deadline, r.requirements_text,
              r.status::text, r.created_at,
              (r.agent_id = app.current_agent_id()) as is_mine,
              a.full_name as agent_name,
              (select count(*) from matches m where m.requirement_id = r.id)::int as matches_total,
              (select count(*) from showings sh
                 join matches m on m.id = sh.match_id
                where m.requirement_id = r.id)::int as showings_total
         from requirements r
         left join contacts c on c.id = r.contact_id
         left join agents a on a.id = r.agent_id
        where r.id = $1`,
      [id],
    );
    if (reqRows.length === 0) return null;

    const [candidates, proposed, showings] = await Promise.all([
      db.query<MatchCandidate>(
        `select object_id, address, kind::text, zone, rooms, area::text, floor,
                floors_total, price::text, currency, actual_at,
                publication_state::text, photos_count, listing_agent, is_mine,
                fit, already_proposed
           from app.matching_objects($1)`,
        [id],
      ),
      db.query<ProposedMatch>(
        `select v.match_id, v.object_id, v.address, v.price::text, v.currency,
                v.match_status::text, v.showing_at, v.rejection_reason,
                v.commission_total::text, v.closing_share::text,
                v.deal_id, v.deal_status::text
           from requirement_matches_v v
          where v.requirement_id = $1
          order by v.created_at desc`,
        [id],
      ),
      db.query(
        `select sh.id, sh.match_id, o.address, sh.scheduled_at, sh.status::text,
                sh.outcome::text, sh.client_reaction::text
           from showings sh
           join matches m on m.id = sh.match_id
           join objects o on o.id = m.object_id
          where m.requirement_id = $1
          order by sh.scheduled_at desc`,
        [id],
      ),
    ]);

    return {
      requirement: reqRows[0],
      candidates: candidates.rows,
      proposed: proposed.rows,
      showings: showings.rows as RequirementDetail["showings"],
    };
  });
}
