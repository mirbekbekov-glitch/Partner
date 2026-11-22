/**
 * S3-совместимое хранилище: Supabase Storage, MinIO, сам S3 — и R2, если
 * приложение живёт не в воркере.
 *
 * Драйвер один на всех, потому что протокол один: менять провайдера — это
 * менять четыре переменные окружения, а не писать код.
 *
 * В продакшне на Cloudflare используется не он, а `storage.r2.ts`: привязка
 * ходит к бакету внутри платформы, без ключей и без AWS SDK. Этот драйвер
 * остаётся потому, что им проверяется слой в node (`npm run smoke:storage`) и
 * им же сделан перенос фотографий с диска.
 *
 * Файл никогда не вычисляется в воркере: `lib/storage.ts` импортирует его
 * отложенно и только когда PHOTO_STORAGE=s3.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Driver } from "./storage.ts";

declare global {
  // Клиент переживает перезагрузку модулей в dev: иначе на каждую правку
  // файла заводилось бы новое соединение.
  var __photoS3: S3Client | undefined;
}

function bucket(): string {
  const name = process.env.PHOTO_S3_BUCKET;
  if (!name) {
    throw new Error(
      "PHOTO_S3_BUCKET не задан, а PHOTO_STORAGE=s3. Смотрите web/.env.example.",
    );
  }
  return name;
}

function client(): S3Client {
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

export const driver: Driver = {
  async put(key, bytes, contentType) {
    await client().send(
      new PutObjectCommand({
        Bucket: bucket(),
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
      const out = await client().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      if (!out.Body) return null;
      const body = out.Body as { transformToWebStream(): ReadableStream };
      return {
        body: body.transformToWebStream(),
        size: typeof out.ContentLength === "number" ? out.ContentLength : null,
        contentType: out.ContentType ?? "image/webp",
      };
    } catch (error) {
      // «Нет такого ключа» — это ответ, а не поломка: маршрут отдаст 404.
      // Всё остальное — поломка, и молчать о ней нельзя.
      if (error instanceof NoSuchKey) return null;
      const code = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (code.name === "NotFound" || code.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },

  async remove(key) {
    try {
      await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    } catch (error) {
      console.error(`не удалось убрать файл ${key}: ${String(error)}`);
    }
  },
};
