import { read } from "@/lib/photos";
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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
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

  const file = await read(key);
  if (!file) {
    // Запись в базе есть, а файла нет. Для посетителя это то же «не найдено»,
    // но в журнал сервера попадёт, что хранилище и база разошлись.
    console.error(`фотография ${key} есть в базе, но не найдена в хранилище`);
    return new Response("Не найдено", { status: 404 });
  }

  return new Response(file.body, {
    headers: {
      // Тип берётся из базы, а не из хранилища: в базе он записан при
      // загрузке нами, и именно он — ответ на вопрос «что это за файл».
      "content-type": row.content_type,
      ...(file.size === null ? {} : { "content-length": String(file.size) }),
      // Короткий кеш и только в браузере посетителя: общий кеш продолжал бы
      // отдавать фотографию снятого объекта, а это ровно то, что инвариант 11
      // запрещает.
      "cache-control": "private, max-age=60",
    },
  });
}
