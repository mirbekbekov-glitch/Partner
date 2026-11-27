import 'server-only';
import { env } from 'cloudflare:workers';
import { batch, newId, now, stmt } from './sql';
import { auditStmt } from './audit';
import { requireAdmin, requireAgent, requireSelf } from './session';
import { canEditObject } from './access';
import { Forbidden, Invalid, NotFound } from './errors';
import { fullKeyOf, thumbKey } from '../photo-url';

/**
 * Снимки объектов в R2.
 *
 * Зачем вообще. Раньше агент вставлял ссылку на чужой хостинг, и ссылка
 * протухала вместе с чужим хостингом: объявление оставалось, а картинки
 * не было. По значку сломанной картинки посетитель судит не о ссылке, а
 * об агентстве.
 *
 * Ключ: objects/<id объекта>/<случайный id>.<расширение>. Объект в ключе —
 * чтобы снимки объекта можно было найти и удалить разом. Случайный id —
 * чтобы ключ ничего не сообщал: ни имени файла с телефона агента, ни
 * порядка загрузки.
 *
 * Отдаются снимки через собственный маршрут /photos/*, а не прямым
 * адресом R2: ведро остаётся закрытым, а адрес снимка не привязан к
 * имени ведра и аккаунту.
 */

/** Больше 10 МБ с телефона не приходит, а приходит — это уже не фото объекта. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Сколько снимков на объект. Больше двадцати никто не листает. */
export const MAX_PER_OBJECT = 20;

/**
 * Тип определяется по СОДЕРЖИМОМУ, а не по тому, что сказал браузер.
 *
 * Заголовок content-type присылает клиент, и подделать его тривиально.
 * Маршрут отдачи ставит этот тип в ответ, то есть чужой файл с чужим типом
 * мы бы отдали посетителю от своего имени.
 */
const SIGNATURES: Array<{ ext: string; type: string; test: (b: Uint8Array) => boolean }> = [
  {
    ext: 'jpg', type: 'image/jpeg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'png', type: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: 'webp', type: 'image/webp',
    test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP',
  },
  {
    ext: 'avif', type: 'image/avif',
    test: (b) => ascii(b, 4, 4) === 'ftyp' && ascii(b, 8, 4).startsWith('avif'),
  },
];

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let out = '';
  for (let i = from; i < from + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/** Что это за файл на самом деле. Не картинка — ничего. */
export function sniff(bytes: Uint8Array): { ext: string; type: string } | null {
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

/** Привязка хранилища. */
function bucket(): R2Bucket {
  const binding = (env as unknown as { PHOTOS?: R2Bucket }).PHOTOS;
  if (!binding) {
    throw new Error(
      'Нет привязки R2 «PHOTOS». Она описана в cloudflare.config.ts и требует '
      + 'включённого на аккаунте R2.',
    );
  }
  return binding;
}

/** Путь, по которому снимок отдаётся посетителю. Относительный: домен может смениться. */
export function photoUrl(key: string): string {
  return `/photos/${key}`;
}

/** Обратно: из пути в ключ. Чужие пути не принимаются. */
export function photoKey(url: string): string | null {
  const match = /^\/photos\/(objects\/[0-9a-f-]+\/[0-9a-f-]+\.[a-z]+)$/i.exec(url.trim());
  return match ? match[1] : null;
}

export type Stored = { key: string; url: string; type: string; size: number };

/**
 * Миниатюра кладётся рядом с полным снимком по известному правилу:
 * `…/abc.jpg` → `…/abc@thumb.webp`. Правило — в lib/photo-url.ts, им же
 * пользуется каталог, чтобы вывести адрес миниатюры без обращения к базе.
 *
 * Миниатюра НЕ считается снимком: она не попадает в listPhotos, не
 * расходует лимит в двадцать штук и не показывается агенту отдельной
 * карточкой. Иначе агент загрузил бы десять снимков и увидел двадцать.
 */
function isThumb(key: string): boolean {
  return key.endsWith('@thumb.webp');
}

/**
 * Положить снимок.
 *
 * Права те же, что на правку объекта: снимок — часть объявления, и кто
 * правит объявление, тот и меняет снимки.
 */
export async function putPhoto(
  objectId: string,
  file: Blob,
  thumb?: Blob | null,
): Promise<Stored> {
  await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Загружать снимки может тот, кто отвечает за объект');
  }

  if (file.size === 0) throw new Invalid('Пустой файл');
  if (file.size > MAX_BYTES) {
    throw new Invalid(`Снимок больше ${Math.round(MAX_BYTES / 1024 / 1024)} МБ`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    throw new Invalid('Это не похоже на снимок: принимаются JPEG, PNG, WebP и AVIF');
  }

  const existing = await listPhotos(objectId);
  if (existing.length >= MAX_PER_OBJECT) {
    throw new Invalid(`Больше ${MAX_PER_OBJECT} снимков на объект не нужно`);
  }

  const key = `objects/${objectId}/${newId()}.${kind.ext}`;

  await bucket().put(key, bytes, {
    httpMetadata: {
      contentType: kind.type,
      // Ключ случайный и неизменный, поэтому содержимое по нему никогда не
      // меняется: можно кешировать навсегда.
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  // Миниатюра — отдельный файл, и её тоже проверяем по содержимому: она
  // приходит тем же запросом из браузера, то есть снаружи, и доверия ей
  // ровно столько же, сколько самому снимку.
  if (thumb && thumb.size > 0 && thumb.size <= MAX_BYTES) {
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    const thumbKind = sniff(thumbBytes);

    // Не картинка — просто не кладём. Терять из-за этого сам снимок нельзя:
    // без миниатюры каталог обойдётся, без снимка объявление — нет.
    if (thumbKind) {
      await bucket().put(thumbKey(key), thumbBytes, {
        httpMetadata: {
          contentType: thumbKind.type,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    }
  }

  return { key, url: photoUrl(key), type: kind.type, size: bytes.length };
}

/** Снимки объекта — то, что реально лежит в хранилище. */
export async function listPhotos(objectId: string): Promise<string[]> {
  const listed = await bucket().list({ prefix: `objects/${objectId}/` });
  return listed.objects.map((o) => o.key).filter((k) => !isThumb(k));
}

/**
 * Снимки без миниатюр — для пересчёта.
 *
 * Зачем это нужно, хотя загрузка кладёт миниатюру всегда. Два случая.
 * Снимки, загруженные до того, как сжатие появилось. И снимки из
 * браузеров без OffscreenCanvas: там миниатюру сделать нечем, и форма
 * сознательно отправляет снимок без неё — потерять снимок хуже, чем
 * отдать его тяжёлым. Второй случай не исторический, он будет
 * повторяться.
 *
 * Без миниатюры страница не ломается: маршрут отдачи подставит полный
 * снимок. Но карточка в списке потянет двухтысячепиксельный файл вместо
 * семидесяти килобайт, и так — на каждой карточке.
 *
 * Только админу: это обзор всего хранилища разом, а не своих объектов.
 *
 * Листается постранично. R2 отдаёт тысячу ключей за раз, и молча взять
 * первую тысячу значило бы, что пересчёт однажды тихо перестанет
 * доходить до конца.
 */
export async function photosMissingThumb(
  cursor?: string,
): Promise<{ keys: string[]; cursor: string | null; scanned: number }> {
  await requireAdmin();

  const page = await bucket().list({ prefix: 'objects/', limit: 1000, cursor });

  const present = new Set(page.objects.map((o) => o.key));
  const keys = page.objects
    .map((o) => o.key)
    .filter((k) => !isThumb(k) && !present.has(thumbKey(k)));

  return {
    keys,
    cursor: page.truncated ? page.cursor : null,
    scanned: page.objects.length,
  };
}

/**
 * Положить миниатюру к снимку, который уже лежит.
 *
 * Отдельно от putPhoto намеренно: тот заводит НОВЫЙ снимок со случайным
 * ключом и проверяет лимит в двадцать штук. Пересчёт же ничего не
 * добавляет — он достраивает недостающее к существующему, и лимит здесь
 * ни при чём.
 *
 * Права те же, что на правку объекта, и ключ обязан принадлежать этому
 * объекту: иначе чужим ключом можно подменить миниатюру соседнего.
 *
 * Миниатюра проверяется по содержимому, как и снимок: она приходит из
 * браузера, то есть снаружи.
 */
export async function putThumb(
  objectId: string,
  key: string,
  thumb: Blob,
): Promise<void> {
  await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Пересчитывать миниатюры может тот, кто отвечает за объект');
  }
  if (!key.startsWith(`objects/${objectId}/`) || isThumb(key)) {
    throw new Invalid('Снимок не от этого объекта');
  }
  if (!(await bucket().head(key))) {
    throw new NotFound('Снимка нет в хранилище');
  }
  if (thumb.size === 0 || thumb.size > MAX_BYTES) {
    throw new Invalid('Миниатюра неподходящего размера');
  }

  const bytes = new Uint8Array(await thumb.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) throw new Invalid('Миниатюра не похожа на снимок');

  await bucket().put(thumbKey(key), bytes, {
    httpMetadata: {
      contentType: kind.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
}

/** Убрать снимок. Ключ обязан принадлежать этому объекту — иначе чужой. */
export async function deletePhoto(objectId: string, key: string): Promise<void> {
  await requireAgent();

  if (!(await canEditObject(objectId))) {
    throw new Forbidden('Удалять снимки может тот, кто отвечает за объект');
  }
  if (!key.startsWith(`objects/${objectId}/`)) {
    throw new Invalid('Снимок не от этого объекта');
  }

  // Миниатюра уходит вместе со снимком. Останься она — в хранилище
  // накопился бы мусор, который никто никогда не найдёт: на него нет
  // ссылок, и увидеть его можно только в списке ведра.
  await bucket().delete([key, thumbKey(key)]);
}

/**
 * Снимок агента.
 *
 * Отдельная функция, а не putPhoto с другим ключом. Разница не в пути:
 * у снимка объекта права считает мандат, лимит — двадцать штук на объект,
 * и ключ случайный, чтобы ничего не сообщал. Аватарка же своя, одна, и
 * заменяется, а не копится.
 *
 * Ключ детерминированный — avatars/<id агента>.<расширение>, — поэтому
 * новая аватарка затирает старую. Копить их незачем: прежнее лицо агента
 * никому не нужно, а мусор в хранилище нужен ещё меньше.
 *
 * Следствие: адрес прежней аватарки отдаст новую. Это и требуется —
 * ссылка на агента остаётся прежней, где бы она ни стояла.
 */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export async function putAvatar(file: Blob): Promise<{ key: string; url: string }> {
  const agent = await requireSelf();

  if (file.size === 0) throw new Invalid('Пустой файл');
  if (file.size > AVATAR_MAX_BYTES) {
    throw new Invalid(`Аватарка больше ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} МБ`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    throw new Invalid('Это не похоже на снимок: принимаются JPEG, PNG, WebP и AVIF');
  }

  // Прежняя аватарка другого формата осталась бы лежать рядом и отдаваться
  // по своему адресу. Убираем все, кроме той, что кладём.
  const old = await bucket().list({ prefix: `avatars/${agent.id}.` });
  const key = `avatars/${agent.id}.${kind.ext}`;
  const stale = old.objects.map((o) => o.key).filter((k) => k !== key);
  if (stale.length > 0) await bucket().delete(stale);

  await bucket().put(key, bytes, {
    httpMetadata: {
      contentType: kind.type,
      // Ключ постоянный, содержимое меняется — вечный кеш здесь солгал бы.
      cacheControl: 'public, max-age=300',
    },
  });

  // Ключ записывается в карточку агента тем же действием. Иначе файл в
  // хранилище есть, а страница о нём не знает — и наоборот: сменился
  // формат, ключ в карточке остался прежний и ведёт в пустоту.
  const at = now();
  await batch([
    stmt('update agents set avatar_key = ?, updated_at = ? where id = ?',
      key, at, agent.id),
    auditStmt('agents', agent.id, 'update', agent.id, { avatar_key: key }),
  ]);

  return { key, url: photoUrl(key) };
}

/** Убрать свою аватарку. */
export async function deleteAvatar(): Promise<void> {
  const agent = await requireSelf();
  const listed = await bucket().list({ prefix: `avatars/${agent.id}.` });
  if (listed.objects.length > 0) {
    await bucket().delete(listed.objects.map((o) => o.key));
  }

  const at = now();
  await batch([
    stmt('update agents set avatar_key = null, updated_at = ? where id = ?',
      at, agent.id),
    auditStmt('agents', agent.id, 'update', agent.id, { avatar_key: null }),
  ]);
}

/** Отдать снимок посетителю. */
export async function readPhoto(key: string): Promise<{
  body: ReadableStream; type: string; etag: string; size: number;
} | null> {
  // Ключ приходит из адреса, то есть снаружи. Пускаем только тот вид, который
  // выдаём сами: иначе «../» и прочие игры с путём. Панорамы лежат под
  // своим префиксом — тем же маршрутом, но отдельной веткой: их ключи не
  // должны проходить там, где ждут снимок объекта.
  //
  // Идентификатор объекта не обязан быть шестнадцатеричным: объекты,
  // заведённые не через newId(), существуют, и их снимки отдавались
  // четырёхсотым. Точки и косые в нём по-прежнему запрещены — ради
  // этого проверка и стоит.
  const own = /^objects\/[\w-]+\/[0-9a-f-]+\.[a-z]+(@thumb\.webp)?$/i.test(key)
    // Идентификатор объекта здесь не обязан быть шестнадцатеричным:
    // объекты, заведённые не через newId(), существуют. Точки и косые в
    // нём по-прежнему запрещены — ради этого проверка и стоит.
    || /^panoramas\/[\w-]+\/[0-9a-f-]+\.[a-z]+$/i.test(key)
    || /^avatars\/[0-9a-f-]+\.[a-z]+$/i.test(key);
  if (!own) return null;

  let object = await bucket().get(key);

  // Миниатюры нет — отдаём полный снимок.
  //
  // Это не запас на всякий случай, а единственный путь для снимков,
  // загруженных до появления сжатия, и для тех, чей браузер сжать не смог.
  // Адрес миниатюры каталог выводит по правилу, не спрашивая хранилище, —
  // значит он попросит её и там, где её нет. Без этой подстановки в таких
  // карточках была бы дырка вместо фотографии.
  if (!object) {
    const full = fullKeyOf(key);
    if (full) object = await bucket().get(full);
  }

  if (!object) return null;

  return {
    body: object.body as ReadableStream,
    type: object.httpMetadata?.contentType ?? 'application/octet-stream',
    etag: object.httpEtag,
    size: object.size,
  };
}

export { NotFound };
