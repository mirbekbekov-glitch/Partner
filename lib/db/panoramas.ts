import 'server-only';
import { env } from 'cloudflare:workers';
import { one, run, newId, now } from './sql';
import { auditStmt } from './audit';
import { batch, stmt } from './sql';
import { requireAgent } from './session';
import { canEditObject } from './access';
import { Forbidden, Invalid, NotFound } from './errors';
import { sniff } from './photos';

/**
 * Панорамы объекта — основа виртуального тура.
 *
 * Чем отличается от снимка. Снимок смотрят целиком; панораму
 * просмотрщик режет и показывает кусок градусов в шестьдесят, растягивая
 * его на весь экран. Поэтому у панорамы свои правила: своё хранилище
 * ключей, своё ограничение размера и свои размеры в пикселях рядом с
 * записью.
 *
 * Почему размеры хранятся. По отношению ширины к высоте просмотрщик
 * считает, сколько градусов по вертикали охватывает снимок: полная сфера
 * это 2:1, а панорама с телефона — полоса 4:1 и выше. Без этого числа
 * тур показывал бы квартиру сплющенной. Считает размеры браузер при
 * загрузке: в Worker'е картинку разобрать нечем.
 *
 * Ключи лежат под своим префиксом panoramas/<объект>/, а не рядом со
 * снимками: listPhotos() перечисляет хранилище по префиксу объекта, и
 * панорама, попавшая туда, стала бы обложкой объявления.
 */

export type Panorama = {
  key: string;
  url: string;
  /** Подпись комнаты: «Кухня», «Гостиная». Задаёт агент. */
  room: string;
  /** Размеры после сжатия в браузере. Ноль — размеры неизвестны. */
  w: number;
  h: number;
};

/** Панорама тяжелее снимка: это полный оборот, а не один кадр. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Больше дюжины комнат в одном туре не ходят. */
export const MAX_PANORAMAS = 12;

/** Подпись комнаты: короткая строка, а не сочинение. */
const MAX_ROOM = 40;

function bucket(): R2Bucket {
  const binding = (env as unknown as { PHOTOS?: R2Bucket }).PHOTOS;
  if (!binding) throw new NotFound('Хранилище снимков не подключено');
  return binding;
}

/** Адрес панорамы — через свой маршрут, как и у снимков. */
function panoramaUrl(key: string): string {
  return `/photos/${key}`;
}

function parse(text: string | null | undefined): Panorama[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      const p = item as Partial<Panorama>;
      if (typeof p.key !== 'string' || typeof p.url !== 'string') return [];
      return [{
        key: p.key,
        url: p.url,
        room: typeof p.room === 'string' ? p.room : '',
        w: typeof p.w === 'number' ? p.w : 0,
        h: typeof p.h === 'number' ? p.h : 0,
      }];
    });
  } catch {
    // Мусор в колонке означает «панорам нет», а не падение страницы:
    // объявление важнее тура.
    return [];
  }
}

/** Панорамы объекта как они записаны. Чтение без проверки прав: тур публичен. */
export async function panoramasOf(objectId: string): Promise<Panorama[]> {
  const row = await one<{ panoramas: string | null }>(
    'select panoramas from objects where id = ?', objectId,
  );
  return parse(row?.panoramas);
}

/** То же из уже прочитанной колонки — для страниц, которые читают объект целиком. */
export function panoramasFrom(column: unknown): Panorama[] {
  return parse(typeof column === 'string' ? column : null);
}

async function save(objectId: string, list: Panorama[], note: Record<string, unknown>) {
  const agent = await requireAgent();
  const at = now();

  await batch([
    stmt('update objects set panoramas = ?, updated_at = ? where id = ?',
      JSON.stringify(list), at, objectId),
    auditStmt('objects', objectId, 'update', agent.id, note),
  ]);
}

/**
 * Положить панораму.
 *
 * Права те же, что на правку объекта: тур — часть объявления, и правит
 * его тот, кто отвечает за объект.
 */
export async function putPanorama(
  objectId: string,
  file: Blob,
  room: string,
  size: { w: number; h: number },
): Promise<Panorama> {
  await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Загружать панорамы может тот, кто отвечает за объект');
  }

  if (file.size === 0) throw new Invalid('Пустой файл');
  if (file.size > MAX_BYTES) {
    throw new Invalid(`Панорама больше ${Math.round(MAX_BYTES / 1024 / 1024)} МБ`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    throw new Invalid('Это не похоже на снимок: принимаются JPEG, PNG, WebP и AVIF');
  }

  const list = await panoramasOf(objectId);
  if (list.length >= MAX_PANORAMAS) {
    throw new Invalid(`Больше ${MAX_PANORAMAS} панорам на объект не нужно`);
  }

  const key = `panoramas/${objectId}/${newId()}.${kind.ext}`;
  await bucket().put(key, bytes, {
    httpMetadata: {
      contentType: kind.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  const entry: Panorama = {
    key,
    url: panoramaUrl(key),
    room: room.trim().slice(0, MAX_ROOM),
    w: Math.max(0, Math.trunc(size.w)),
    h: Math.max(0, Math.trunc(size.h)),
  };

  await save(objectId, [...list, entry], { panorama: 'added', room: entry.room });
  return entry;
}

/** Подписать комнату — или переподписать, если агент ошибся. */
export async function renamePanorama(
  objectId: string, key: string, room: string,
): Promise<Panorama[]> {
  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Править тур может тот, кто отвечает за объект');
  }

  const list = await panoramasOf(objectId);
  if (!list.some((p) => p.key === key)) throw new NotFound('Такой панорамы у объекта нет');

  const next = list.map((p) => (
    p.key === key ? { ...p, room: room.trim().slice(0, MAX_ROOM) } : p
  ));
  await save(objectId, next, { panorama: 'renamed' });
  return next;
}

/**
 * Убрать панораму — и из записи, и из хранилища.
 *
 * Сначала запись, потом файл: если файл не удалится, в хранилище
 * останется лишний объект, и это мелкая беда. Если же наоборот —
 * останется запись о файле, которого нет, и тур покажет пустоту.
 */
export async function deletePanorama(objectId: string, key: string): Promise<void> {
  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Править тур может тот, кто отвечает за объект');
  }

  if (!key.startsWith(`panoramas/${objectId}/`)) {
    throw new Invalid('Эта панорама не от этого объекта');
  }

  const list = await panoramasOf(objectId);
  await save(objectId, list.filter((p) => p.key !== key), { panorama: 'removed' });
  await bucket().delete(key);
}

/** Сколько панорам у объекта — для карточки в кабинете. */
export async function panoramaCount(objectId: string): Promise<number> {
  return (await panoramasOf(objectId)).length;
}

/** Убрать все панорамы объекта: зовётся при удалении объекта. */
export async function dropPanoramas(objectId: string): Promise<void> {
  const list = await panoramasOf(objectId);
  for (const p of list) await bucket().delete(p.key).catch(() => undefined);
  await run('update objects set panoramas = null where id = ?', objectId);
}
