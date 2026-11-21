import { asReportRole } from "../../../lib/db";
import { buildFeed, type FeedItem } from "../../../lib/feed";

/**
 * Фид канала: /feed/<токен>.xml
 *
 * По ту сторону площадка, а не вошедший агент, поэтому запрос идёт под ролью
 * `anon` — с теми же правами, что у публичного каталога. Роль не получает ни
 * таблиц, ни чего-либо сверх публичного: ей открыты ровно две функции
 * (инвариант 28).
 *
 * Токен в адресе — не защита каталога, он и так публичный. Токен нужен, чтобы
 * обращение за фидом можно было ОТНЕСТИ к площадке: иначе запись в журнале
 * значила бы «кто-то когда-то зашёл», и строчка «Лалафо забрала фид» снова
 * стала бы догадкой.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const token = file.endsWith(".xml") ? file.slice(0, -4) : file;

  // Токен идёт в SQL параметром, но проверяется и здесь: в адресе бывает что
  // угодно, а лишний поход в базу на мусор не нужен.
  if (!/^[0-9a-f]{32,128}$/.test(token)) {
    return new Response("не фид\n", { status: 404 });
  }

  const feed = await asReportRole(async (db) => {
    const { rows: channels } = await db.query<{ channel: string | null }>(
      "select app.channel_by_token($1) as channel",
      [token],
    );
    const channel = channels[0]?.channel ?? null;
    if (!channel) return null;

    const { rows } = await db.query<FeedItem>(
      "select * from app.channel_feed($1::publication_channel)",
      [channel],
    );

    const xml = buildFeed(channel, rows, new Date());

    // Запись об обращении — единственное доказательство, что выгрузка живёт.
    // Пишется после сборки: если сборка упала, записи быть не должно.
    await db.query("select app.record_channel_fetch($1::publication_channel, $2, $3)", [
      channel,
      rows.length,
      Buffer.byteLength(xml, "utf8"),
    ]);

    return xml;
  });

  if (feed === null) {
    // Неизвестный или отключённый токен отвечает тем же, чем мусор в адресе:
    // по ответу нельзя отличить «такого канала нет» от «канал выключен».
    return new Response("не фид\n", { status: 404 });
  }

  return new Response(feed, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // Фид отдаётся площадке, а не человеку, и кэшировать его посредникам
      // незачем: объект, снятый с публикации, обязан исчезнуть сразу.
      "cache-control": "no-store",
    },
  });
}
