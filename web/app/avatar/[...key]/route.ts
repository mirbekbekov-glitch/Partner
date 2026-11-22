import { Readable } from "node:stream";
import { read } from "@/lib/photos";
import { asAgent } from "@/lib/db";
import { readSession } from "@/lib/session";

/**
 * Отдача аватара агента.
 *
 * Отличие от фотографии объекта одно, и оно решающее: аватар отдаётся
 * ВОШЕДШЕМУ агенту, а не анониму. Лицо агента — внутреннее дело платформы:
 * ни подборка клиенту, ни отчёт собственнику агента не показывают вовсе, и
 * открытый адрес картинки обошёл бы это молча.
 *
 * Путь из запроса в файловую систему не подставляется на веру: сначала ключ
 * должен найтись в базе, и форма ключа ограничена проверкой схемы
 * (инвариант 38). Обход каталога невозможен дважды.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const session = await readSession();
  if (!session) return new Response("Не найдено", { status: 404 });

  const { key: segments } = await params;
  const key = segments.join("/");

  const found = await asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from platform_agents_v where avatar_key = $1",
      [key],
    );
    return rows.length > 0;
  });

  if (!found) return new Response("Не найдено", { status: 404 });

  const file = await read(key);
  if (!file) {
    console.error(`аватар ${key} есть в базе, но не найден в хранилище`);
    return new Response("Не найдено", { status: 404 });
  }

  const stream = Readable.toWeb(file.body) as unknown as ReadableStream;

  return new Response(stream, {
    headers: {
      "content-type": "image/webp",
      ...(file.size === null ? {} : { "content-length": String(file.size) }),
      // Приватная картинка: общие кеши её хранить не должны.
      "cache-control": "private, max-age=300",
    },
  });
}
