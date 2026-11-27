import 'server-only';
import { one } from './sql';
import { batch, newId, now, stmt } from './sql';
import { auditStmt } from './audit';
import { requireAgent } from './session';
import { canEditObject } from './access';
import { Forbidden, Invalid, NotFound } from './errors';
import { putPhoto } from './photos';

/**
 * Обработанные снимки объекта.
 *
 * Что здесь считается правдой. Оригинал — то, что снял агент; он
 * сохраняется всегда и остаётся в хранилище. Показывается обработанный
 * снимок, и если с него стёрли предметы, объявление об этом сообщает.
 *
 * Почему пометка только за стирание. Свет и баланс белого не меняют
 * квартиру: тёмный кадр и тот же кадр со светом показывают одну и ту же
 * комнату. Стёртый предмет меняет то, что покупатель увидит на показе, и
 * умалчивать об этом нельзя. Помечать же каждую поправку света значило бы
 * повесить ярлык на все фотографии разом — и он перестал бы читаться.
 */

export type PhotoEdit = {
  /** Что показывается в объявлении. */
  url: string;
  /** Что снял агент. Остаётся в хранилище навсегда. */
  original: string;
  /** Стирали ли с кадра предметы. Пометка в объявлении — за это. */
  erased: boolean;
};

function parse(text: string | null | undefined): PhotoEdit[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      const e = item as Partial<PhotoEdit>;
      if (typeof e.url !== 'string' || typeof e.original !== 'string') return [];
      return [{ url: e.url, original: e.original, erased: e.erased === true }];
    });
  } catch {
    return [];
  }
}

/** Правки снимков объекта. */
export async function editsOf(objectId: string): Promise<PhotoEdit[]> {
  const row = await one<{ photo_edits: string | null }>(
    'select photo_edits from objects where id = ?', objectId,
  );
  return parse(row?.photo_edits);
}

/** То же из уже прочитанной колонки. */
export function editsFrom(column: unknown): PhotoEdit[] {
  return parse(typeof column === 'string' ? column : null);
}

/** Есть ли в объявлении снимки, с которых что-то стёрли. */
export function anyErased(edits: PhotoEdit[]): boolean {
  return edits.some((e) => e.erased);
}

/**
 * Сохранить обработанный снимок вместо исходного.
 *
 * Исходный НЕ удаляется: он остаётся в хранилище и записывается рядом.
 * Это главное свойство функции, а не предосторожность.
 */
export async function saveEdited(
  objectId: string,
  originalUrl: string,
  file: Blob,
  erased: boolean,
): Promise<PhotoEdit> {
  await requireAgent();
  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Обрабатывать снимки может тот, кто отвечает за объект');
  }

  const row = await one<{ photos: string | null }>(
    'select photos from objects where id = ?', objectId,
  );
  if (!row) throw new NotFound('Объект не найден');

  const photos = (() => {
    try {
      const list = JSON.parse(row.photos ?? '[]') as unknown;
      return Array.isArray(list) ? list.map((p) => (
        typeof p === 'string' ? p : String((p as { url?: string }).url ?? '')
      )) : [];
    } catch {
      return [];
    }
  })();

  const at = photos.indexOf(originalUrl);
  if (at < 0) throw new Invalid('Этого снимка у объекта нет');

  // Новый снимок кладётся как обычный: тем же проверенным путём, с той же
  // проверкой типа по содержимому и тем же лимитом.
  const stored = await putPhoto(objectId, file);

  const edits = await editsOf(objectId);
  // Повторная обработка уже обработанного: оригиналом остаётся ПЕРВЫЙ
  // снимок, а не предыдущая правка. Иначе цепочка правок потеряла бы то,
  // что было на самом деле.
  const known = edits.find((e) => e.url === originalUrl);
  const original = known?.original ?? originalUrl;

  const next: PhotoEdit = {
    url: stored.url,
    original,
    erased: erased || known?.erased === true,
  };

  const list = [...edits.filter((e) => e.url !== originalUrl), next];
  const nextPhotos = photos.map((p) => (p === originalUrl ? stored.url : p));
  const agent = await requireAgent();

  await batch([
    stmt('update objects set photos = ?, photo_edits = ?, updated_at = ? where id = ?',
      JSON.stringify(nextPhotos), JSON.stringify(list), now(), objectId),
    auditStmt('objects', objectId, 'update', agent.id, {
      photo: 'edited', erased: next.erased,
    }),
  ]);

  return next;
}

/**
 * Вернуть оригинал.
 *
 * Возврат возможен всегда и именно поэтому обработка не страшна: что бы
 * агент ни сделал со снимком, одно нажатие возвращает то, что он снял.
 */
export async function restoreOriginal(
  objectId: string, url: string,
): Promise<void> {
  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Возвращать оригинал может тот, кто отвечает за объект');
  }

  const edits = await editsOf(objectId);
  const edit = edits.find((e) => e.url === url);
  if (!edit) throw new NotFound('Этот снимок не обрабатывали');

  const row = await one<{ photos: string | null }>(
    'select photos from objects where id = ?', objectId,
  );
  const photos = (() => {
    try {
      const list = JSON.parse(row?.photos ?? '[]') as unknown;
      return Array.isArray(list) ? list.map((p) => (
        typeof p === 'string' ? p : String((p as { url?: string }).url ?? '')
      )) : [];
    } catch {
      return [];
    }
  })();

  const agent = await requireAgent();
  await batch([
    stmt('update objects set photos = ?, photo_edits = ?, updated_at = ? where id = ?',
      JSON.stringify(photos.map((p) => (p === url ? edit.original : p))),
      JSON.stringify(edits.filter((e) => e.url !== url)),
      now(), objectId),
    auditStmt('objects', objectId, 'update', agent.id, { photo: 'restored' }),
  ]);
}

/** Новый ключ для обработанного снимка — тот же вид, что у обычного. */
export function editedKey(objectId: string, ext: string): string {
  return `objects/${objectId}/${newId()}.${ext}`;
}
