import 'server-only';
import { env } from 'cloudflare:workers';
import { all, batch, now, one, stmt, toJson } from './sql';
import { auditStmt } from './audit';
import { searchText } from './normalize';
import { draftsFromCatalog, parseCsv, type ImportedDraft } from '@/lib/catalog-csv';

/**
 * Перенос объявлений старого сайта в кабинет.
 *
 * Старый сайт присылает свой каталог на чужой Worker, тот складывает его
 * снимком в базу liberterra-catalog. Мы читаем снимок привязкой CATALOG —
 * только на чтение — и заводим из него ЧЕРНОВИКИ объектов.
 *
 * Черновики, а не публикации, и это не осторожность, а инвариант: без
 * активного мандата объект публиковать нельзя, а договоров в выгрузке нет
 * вовсе. Импорт не заводит мандатов и не трогает publication_state.
 *
 * ИМПОРТ ТОЛЬКО ЗАВОДИТ, НИКОГДА НЕ ПРАВИТ. Один раз перенесённый объект
 * принадлежит агентству: агент уточнил адрес, перезалил снимки, завёл
 * договор. Если бы расписание каждую ночь переписывало такую карточку
 * тем, что лежит на старом сайте, эта работа пропадала бы молча. Поэтому
 * строка с уже известным идентификатором пропускается, какой бы она ни
 * пришла. Удалять импорт тоже не умеет.
 */

/** Отметка источника: по ней видно, что карточка приехала, а не заведена. */
export const IMPORT_SOURCE = 'старый сайт';

export type ImportReport = {
  /** Строк в снимке. */
  rows: number;
  /** Заведено черновиков за этот прогон. */
  imported: number;
  /** Было заведено раньше — пропущено. */
  already: number;
  /** Пропущено по разбору, с причинами. */
  skipped: number;
  reasons: Record<string, number>;
  /** Когда старый сайт сформировал снимок. */
  snapshotAt: string | null;
  /** На кого записаны черновики. */
  agentId: string | null;
  note?: string;
};

function catalogBinding(): D1Database | null {
  return (env as unknown as { CATALOG?: D1Database }).CATALOG ?? null;
}

/**
 * Чей черновик.
 *
 * Объект обязан ссылаться на живого агента, и выбор тут не случайный:
 * старший администратор — тот, кто в состоянии раздать карточки дальше.
 * Если администратора нет, импорт не выдумывает автора, а отказывается
 * работать: карточка без хозяина потерялась бы.
 */
async function importOwner(): Promise<string | null> {
  const row = await one<{ id: string }>(
    `select id from agents
      where role = 'admin' and status = 'approved'
      order by created_at limit 1`,
  );
  return row?.id ?? null;
}

export async function importCatalog(): Promise<ImportReport> {
  const empty: ImportReport = {
    rows: 0, imported: 0, already: 0, skipped: 0, reasons: {},
    snapshotAt: null, agentId: null,
  };

  const catalog = catalogBinding();
  if (!catalog) {
    return { ...empty, note: 'нет привязки CATALOG — импорт выключен' };
  }

  const snapshot = await catalog.prepare(
    'select body, generated_at_ms from public_catalog_snapshot limit 1',
  ).first<{ body: string; generated_at_ms: number }>();

  if (!snapshot?.body) {
    return { ...empty, note: 'снимок каталога пуст' };
  }

  const snapshotAt = new Date(snapshot.generated_at_ms).toISOString();
  const rows = parseCsv(snapshot.body);
  const { drafts, skipped } = draftsFromCatalog(rows);

  const reasons: Record<string, number> = {};
  for (const s of skipped) {
    // Причины считаем по виду, а не поштучно: «не объявление, а запрос»
    // встречается сотнями, и список из трёхсот одинаковых строк в журнале
    // ничего не сообщает.
    const key = s.why.replace(/:.*$/, '');
    reasons[key] = (reasons[key] ?? 0) + 1;
  }

  const base: ImportReport = {
    rows: rows.length, imported: 0, already: 0,
    skipped: skipped.length, reasons, snapshotAt, agentId: null,
  };

  if (drafts.length === 0) return base;

  const agentId = await importOwner();
  if (!agentId) {
    return { ...base, note: 'нет одобренного администратора — заводить черновики не на кого' };
  }

  // Что уже заводили. Идентификатор приходит со старого сайта и остаётся
  // идентификатором карточки: по нему видно происхождение, и повторный
  // прогон узнаёт своё.
  const known = new Set(
    (await all<{ id: string }>('select id from objects')).map((r) => r.id),
  );

  const fresh = drafts.filter((d) => !known.has(d.id));
  const already = drafts.length - fresh.length;
  if (fresh.length === 0) return { ...base, already, agentId };

  const at = now();
  const writes = fresh.flatMap((d: ImportedDraft) => [
    stmt(
      `insert into objects (
         id, kind, deal_type, address, city, zone, rooms, area, floor, floors_total,
         price_minor, currency, photos, description, source, search_text,
         publication_state, published_at, actual_at,
         created_by_agent_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', null, ?, ?, ?, ?)`,
      d.id, d.kind, d.deal_type, d.address, d.city, d.zone,
      d.rooms, d.area, d.floor, d.floors_total,
      d.price_minor, d.currency, toJson(d.photos), d.description,
      IMPORT_SOURCE, searchText(d.address, d.city, d.zone),
      d.actual_at, agentId, at, at,
    ),
    // В журнале стоит «система»: карточку завёл не агент, а расписание.
    auditStmt('objects', d.id, 'insert', null, {
      source: IMPORT_SOURCE, address: d.address, price_minor: d.price_minor,
    }),
  ]);

  await batch(writes);

  return { ...base, imported: fresh.length, already, agentId };
}
