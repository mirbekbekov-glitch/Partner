import { Readable } from "node:stream";
import { read } from "@/lib/photos";
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
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

  const file = await read(key);
  if (!file) {
    console.error(`фотография ${key} есть в базе, но не найдена в хранилище`);
    return new Response("Не найдено", { status: 404 });
  }

  const stream = Readable.toWeb(file.body) as unknown as ReadableStream;

  return new Response(stream, {
    headers: {
      // Тип берётся из базы: там он записан при загрузке нами.
      "content-type": row.content_type,
      ...(file.size === null ? {} : { "content-length": String(file.size) }),
      // Только в браузере этого агента и ненадолго: фотографию могли удалить
      // или объект — снять с публикации.
      "cache-control": "private, max-age=60",
    },
  });
}
