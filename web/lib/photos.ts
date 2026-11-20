import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import sharp, { type OutputInfo } from "sharp";

/**
 * Хранилище фотографий.
 *
 * ФАЙЛ, ПОПАВШИЙ В ХРАНИЛИЩЕ, СОЗДАН НАМИ. Байты, присланные браузером,
 * никуда не записываются: они расшифровываются и кодируются заново. Это одно
 * решение закрывает сразу четыре вещи, и каждая из них иначе требовала бы
 * своей проверки:
 *
 *   — EXIF. Телефон пишет в снимок координаты. Для фотографии квартиры это
 *     адрес собственника с точностью до подъезда, и в публичный каталог он
 *     попадать не должен. Перекодирование выбрасывает все метаданные;
 *   — не-изображение. Файл, который не разбирается как картинка, не
 *     закодируется обратно. Проверять расширение и заголовок Content-Type
 *     незачем: их пишет тот, кто прислал файл;
 *   — размер. Снимок с телефона — это 4–12 МБ и 4000 точек по длинной
 *     стороне. В каталоге это секунды загрузки на мобильном интернете;
 *   — формат. В хранилище лежит один формат вместо трёх.
 *
 * КЛЮЧ ВЫДАЁТ СЕРВЕР. Имя файла из браузера не участвует: ни как имя, ни как
 * часть пути. Форма ключа ограничена проверкой схемы (инвариант 11), поэтому
 * выйти за каталог объекта нельзя даже ошибкой в этом файле.
 *
 * Хранилище — каталог на диске. Supabase Storage не подключён; когда дойдут
 * руки, меняются только `save` и `remove`, потому что право на файл
 * проверяется в базе на каждый запрос, а не настройками бакета.
 */

/** Длинная сторона после перекодирования. */
const MAX_SIDE = 2000;

/** Предел того, что вообще принимаем на вход. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type StoredPhoto = {
  storageKey: string;
  contentType: "image/webp";
  width: number;
  height: number;
  byteSize: number;
};

function photoDir(): string {
  const dir = process.env.PHOTO_DIR;
  if (!dir) {
    throw new Error(
      "PHOTO_DIR не задан: хранилищу фотографий негде лежать. Смотрите web/.env.example.",
    );
  }
  return dir;
}

/** Путь файла в хранилище. Ключ уже проверен формой — проверяется ещё раз. */
function pathFor(storageKey: string): string {
  const base = normalize(photoDir());
  const path = join(base, normalize(storageKey));
  if (!path.startsWith(base)) {
    throw new Error(`ключ ${storageKey} выводит за пределы хранилища`);
  }
  return path;
}

/**
 * Принять файл: перекодировать и записать. Возвращает то, что нужно базе.
 * В базу ничего не пишет — это дело вызывающего, и порядок важен: сначала
 * файл, потом запись, иначе строка может указывать на то, чего нет.
 */
export async function save(objectId: string, file: File): Promise<StoredPhoto> {
  if (file.size === 0) throw new Error("файл пустой");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `файл ${(file.size / 1024 / 1024).toFixed(1)} МБ, это больше предела в ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ`,
    );
  }

  const input = Buffer.from(await file.arrayBuffer());

  let output: Buffer;
  let info: OutputInfo;
  try {
    const result = await sharp(input, { failOn: "error" })
      // Поворот по EXIF делается ДО того, как EXIF выбрасывается: иначе
      // снимки, сделанные боком, останутся боком.
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    output = result.data;
    info = result.info;
  } catch {
    // Сюда попадает и битый файл, и документ с расширением .jpg, и попытка
    // подсунуть что-нибудь исполняемое. Причина для человека одна.
    throw new Error("это не изображение или оно повреждено");
  }

  const storageKey = `objects/${objectId}/${randomBytes(16).toString("hex")}.webp`;
  const path = pathFor(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output);

  return {
    storageKey,
    contentType: "image/webp",
    width: info.width,
    height: info.height,
    byteSize: output.byteLength,
  };
}

/**
 * Убрать файл из хранилища.
 *
 * Отсутствие файла ошибкой не считается: запись в базе уже удалена, и
 * падать из-за того, что файла и так нет, значит мешать уборке. Разошедшиеся
 * база и хранилище — это сообщение в журнале, а не остановка работы.
 */
export async function remove(storageKey: string): Promise<void> {
  try {
    await rm(pathFor(storageKey), { force: true });
  } catch (error) {
    console.error(`не удалось убрать файл ${storageKey}: ${String(error)}`);
  }
}
