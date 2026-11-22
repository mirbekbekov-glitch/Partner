import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Хранилище файлов.
 *
 * Зачем отдельный слой. Раньше фотографии лежали на диске контейнера, и на
 * любом хостинге это значит одно: они исчезают при следующем выкладывании.
 * Диск годится для разработки и ни для чего больше.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Три действия: положить, прочитать, убрать. Ни
 * списка, ни подписанных ссылок, ни публичных адресов. Это не экономия, а
 * следствие инварианта 11: байты отдаёт приложение, и право на файл
 * проверяется в базе на каждый запрос. Публичный адрес у файла в хранилище
 * обошёл бы эту проверку молча — поэтому бакет закрыт, а функции, которая
 * выдаёт из него прямую ссылку, в этом файле нет.
 *
 * Отсюда же следует, что исходящий трафик фотографий оплачивает хост
 * приложения, где бы ни лежали файлы. Это осознанная цена за то, что снятый
 * с публикации объект перестаёт отдаваться в ту же секунду.
 *
 * ВЫБОР ДРАЙВЕРА — переменная `PHOTO_STORAGE`:
 *
 *   disk (по умолчанию) — каталог `PHOTO_DIR`. Разработка и тесты;
 *   s3                  — любое S3-совместимое хранилище: Cloudflare R2,
 *                         Supabase Storage, MinIO, сам S3.
 *
 * Драйвер s3 один на всех, потому что протокол один. Менять провайдера —
 * это менять четыре переменные окружения, а не писать код.
 */

export type StoredObject = {
  body: Readable;
  size: number | null;
  contentType: string;
};

export interface Storage {
  /** Положить байты под ключом. Ключ выдаёт вызывающий, а не хранилище. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Прочитать. `null` — файла нет; это не ошибка, а ответ. */
  read(key: string): Promise<StoredObject | null>;
  /** Убрать. Отсутствие файла ошибкой не считается: запись уже удалена. */
  remove(key: string): Promise<void>;
  /** Как называть это в сообщениях об ошибках. */
  readonly name: string;
}

/* -------------------------------------------------------------------------
 * Диск
 * ---------------------------------------------------------------------- */

function diskRoot(): string {
  const dir = process.env.PHOTO_DIR;
  if (!dir) {
    throw new Error(
      "PHOTO_DIR не задан: хранилищу фотографий негде лежать. Смотрите web/.env.example.",
    );
  }
  return dir;
}

/**
 * Путь файла в каталоге. Ключ уже ограничен проверкой схемы в базе —
 * проверяется ещё раз: обход каталога не должен зависеть от одной проверки.
 */
function diskPath(key: string): string {
  const base = normalize(diskRoot());
  const path = join(base, normalize(key));
  if (!path.startsWith(base)) {
    throw new Error(`ключ ${key} выводит за пределы хранилища`);
  }
  return path;
}

const disk: Storage = {
  name: "диск",

  async put(key, bytes) {
    const path = diskPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },

  async read(key) {
    let path: string;
    try {
      path = diskPath(key);
    } catch {
      return null;
    }
    try {
      const info = await stat(path);
      return {
        body: createReadStream(path),
        size: info.size,
        contentType: "image/webp",
      };
    } catch {
      return null;
    }
  },

  async remove(key) {
    try {
      await rm(diskPath(key), { force: true });
    } catch (error) {
      console.error(`не удалось убрать файл ${key}: ${String(error)}`);
    }
  },
};

/* -------------------------------------------------------------------------
 * S3-совместимое
 * ---------------------------------------------------------------------- */

declare global {
  // Клиент переживает перезагрузку модулей в dev: иначе на каждую правку
  // файла заводилось бы новое соединение.
  var __photoS3: S3Client | undefined;
}

function s3Bucket(): string {
  const bucket = process.env.PHOTO_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "PHOTO_S3_BUCKET не задан, а PHOTO_STORAGE=s3. Смотрите web/.env.example.",
    );
  }
  return bucket;
}

function s3Client(): S3Client {
  if (!globalThis.__photoS3) {
    const endpoint = process.env.PHOTO_S3_ENDPOINT;
    const accessKeyId = process.env.PHOTO_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.PHOTO_S3_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "PHOTO_S3_ACCESS_KEY_ID и PHOTO_S3_SECRET_ACCESS_KEY не заданы, а PHOTO_STORAGE=s3.",
      );
    }

    globalThis.__photoS3 = new S3Client({
      // У R2 и прочих совместимых регион формальный, но библиотека его
      // требует. «auto» — то, что просит R2.
      region: process.env.PHOTO_S3_REGION ?? "auto",
      endpoint,
      // Путь вида endpoint/bucket/key вместо bucket.endpoint/key. R2, MinIO
      // и Supabase Storage работают так; у самого S3 это тоже допустимо.
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return globalThis.__photoS3;
}

const s3: Storage = {
  name: "S3",

  async put(key, bytes, contentType) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Приватно: ссылку на файл отдаёт приложение, а не хранилище.
        CacheControl: "private, max-age=300",
      }),
    );
  },

  async read(key) {
    try {
      const out = await s3Client().send(
        new GetObjectCommand({ Bucket: s3Bucket(), Key: key }),
      );
      if (!out.Body) return null;
      return {
        body: out.Body as Readable,
        size: typeof out.ContentLength === "number" ? out.ContentLength : null,
        contentType: out.ContentType ?? "image/webp",
      };
    } catch (error) {
      // «Нет такого ключа» — это ответ, а не поломка: маршрут отдаст 404.
      // Всё остальное — поломка, и молчать о ней нельзя.
      if (error instanceof NoSuchKey) return null;
      const code = (error as { name?: string; $metadata?: { httpStatusCode?: number } });
      if (code.name === "NotFound" || code.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },

  async remove(key) {
    try {
      await s3Client().send(
        new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }),
      );
    } catch (error) {
      console.error(`не удалось убрать файл ${key}: ${String(error)}`);
    }
  },
};

/* -------------------------------------------------------------------------
 * Выбор
 * ---------------------------------------------------------------------- */

export function storage(): Storage {
  const kind = process.env.PHOTO_STORAGE ?? "disk";
  if (kind === "s3") return s3;
  if (kind === "disk") return disk;
  throw new Error(
    `PHOTO_STORAGE=${kind} не поддерживается: ожидается disk или s3.`,
  );
}
