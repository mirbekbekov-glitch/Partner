import { randomBytes } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
import { storage } from "./storage.ts";

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
 * ГДЕ ЛЕЖАТ БАЙТЫ — дело `lib/storage.ts`: диск для разработки,
 * S3-совместимое хранилище для всего остального. Этот файл о том, ЧТО в
 * хранилище кладут, и про бакеты не знает ничего. Так и было обещано в
 * первой версии: «меняются только save и remove, потому что право на файл
 * проверяется в базе на каждый запрос, а не настройками бакета».
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
  await storage().put(storageKey, output, "image/webp");

  return {
    storageKey,
    contentType: "image/webp",
    width: info.width,
    height: info.height,
    byteSize: output.byteLength,
  };
}

/** Сторона аватара. Квадрат: в списке агентов он стоит в строке. */
const AVATAR_SIDE = 512;

/**
 * Принять аватар агента.
 *
 * Та же труба, что у фотографии объекта, и это главное: байты из браузера
 * никуда не записываются, они раскодируются и кодируются заново. EXIF с
 * координатами съёмки выбрасывается тем же движением — селфи, сделанное
 * дома, иначе принесло бы домашний адрес агента.
 *
 * Отличий ровно два: квадрат вместо вписывания и сторона поменьше.
 */
export async function saveAvatar(agentId: string, file: File): Promise<StoredPhoto> {
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
      .rotate()
      .resize({ width: AVATAR_SIDE, height: AVATAR_SIDE, fit: "cover", position: "attention" })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    output = result.data;
    info = result.info;
  } catch {
    throw new Error("это не изображение или оно повреждено");
  }

  const storageKey = `avatars/${agentId}/${randomBytes(16).toString("hex")}.webp`;
  await storage().put(storageKey, output, "image/webp");

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
  await storage().remove(storageKey);
}

/**
 * Прочитать файл. Нужна маршрутам отдачи: они сначала спрашивают базу, кому
 * этот файл сейчас положен, и только потом идут за байтами.
 *
 * `null` означает «такого файла нет», и это ответ, а не ошибка: база и
 * хранилище расходятся при любом сбое между записью строки и записью файла.
 */
export async function read(storageKey: string) {
  return storage().read(storageKey);
}
