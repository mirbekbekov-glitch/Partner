import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { asCatalogRole } from "@/lib/db";

/**
 * Отдача файла фотографии.
 *
 * Байты отдаёт приложение, а не хранилище напрямую, и это весь смысл
 * инварианта 11: право на файл проверяется в момент запроса по `public_photo_v`,
 * где лежат фотографии только опубликованных объектов. Сняли объект с
 * публикации — ссылка перестала работать в тот же момент, без переноса файлов
 * и без чистки кешей хранилища.
 *
 * Путь из запроса в файловую систему не подставляется на веру: сначала он
 * должен найтись в базе, а форма ключа ограничена проверкой схемы. Обход
 * каталога невозможен дважды.
 */

const PHOTO_DIR = process.env.PHOTO_DIR;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!PHOTO_DIR) {
    return new Response("Хранилище фотографий не настроено", { status: 500 });
  }

  const { key: segments } = await params;
  const key = segments.join("/");

  const row = await asCatalogRole(async (client) => {
    const { rows } = await client.query<{ content_type: string }>(
      "select content_type from public_photo_v where storage_key = $1",
      [key],
    );
    return rows[0] ?? null;
  });

  // Нет в витрине — значит объект не опубликован либо такой фотографии нет.
  // Разницу наружу не показываем: это разные причины одного ответа.
  if (!row) return new Response("Не найдено", { status: 404 });

  const path = join(PHOTO_DIR, normalize(key));
  if (!path.startsWith(normalize(PHOTO_DIR))) {
    return new Response("Не найдено", { status: 404 });
  }

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return new Response("Не найдено", { status: 404 });
    size = info.size;
  } catch {
    // Запись в базе есть, а файла нет. Для посетителя это то же «не найдено»,
    // но в журнал сервера попадёт, что хранилище и база разошлись.
    console.error(`фотография ${key} есть в базе, но не найдена в хранилище`);
    return new Response("Не найдено", { status: 404 });
  }

  const stream = Readable.toWeb(
    createReadStream(path),
  ) as unknown as ReadableStream;

  return new Response(stream, {
    headers: {
      "content-type": row.content_type,
      "content-length": String(size),
      // Короткий кеш и только в браузере посетителя: общий кеш продолжал бы
      // отдавать фотографию снятого объекта, а это ровно то, что инвариант 11
      // запрещает.
      "cache-control": "private, max-age=60",
    },
  });
}
