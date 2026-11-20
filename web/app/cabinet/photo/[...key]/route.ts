import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { asAgent } from "@/lib/db";
import { readSession } from "@/lib/session";

/**
 * Отдача фотографии агенту.
 *
 * Зачем отдельно от `/photo/[...key]`: та отдача смотрит в `public_photo_v`,
 * где лежат фотографии только опубликованных объектов, — и правильно, это
 * инвариант 11. Но агент загружает фотографии ДО публикации: объект
 * публикуется, когда фотографии уже есть. По публичной ссылке он увидел бы
 * 404 на то, что сам только что загрузил.
 *
 * Поэтому здесь право проверяется иначе, но так же в базе: запрос идёт под
 * ролью вошедшего, и строку отдаёт построчная политика `object_photos_read`.
 * Анониму сюда не попасть — без сессии запрос даже не доходит до базы.
 */

const PHOTO_DIR = process.env.PHOTO_DIR;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!PHOTO_DIR) {
    return new Response("Хранилище фотографий не настроено", { status: 500 });
  }

  const session = await readSession();
  if (!session) return new Response("Нужен вход", { status: 401 });

  const { key: segments } = await params;
  const key = segments.join("/");

  const row = await asAgent(session, "read only", async (client) => {
    const { rows } = await client.query<{ content_type: string }>(
      "select content_type from cabinet_photo_v where storage_key = $1",
      [key],
    );
    return rows[0] ?? null;
  });

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
    console.error(`фотография ${key} есть в базе, но не найдена в хранилище`);
    return new Response("Не найдено", { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;

  return new Response(stream, {
    headers: {
      "content-type": row.content_type,
      "content-length": String(size),
      // Только в браузере этого агента и ненадолго: фотографию могли удалить
      // или объект — снять с публикации.
      "cache-control": "private, max-age=60",
    },
  });
}
