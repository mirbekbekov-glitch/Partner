import { asReportRole } from "../../../lib/db";
import { buildFeed, type FeedItem, type FeedSettings } from "../../../lib/feeds";

/**
 * Фид канала: /feed/<токен>.xml
 *
 * По ту сторону площадка, а не вошедший агент, поэтому запрос идёт под ролью
 * `anon` — с теми же правами, что у публичного каталога. Роль не получает ни
 * таблиц, ни чего-либо сверх публичного: ей открыты считанные функции
 * (инвариант 28).
 *
 * Токен в адресе — не защита каталога, он и так публичный. Токен нужен, чтобы
 * обращение за фидом можно было ОТНЕСТИ к площадке: иначе запись в журнале
 * значила бы «кто-то когда-то зашёл».
 *
 * Схему выбирает не маршрут, а настройка канала: спецификацию площадки
 * узнают вместе с тарифом, и менять её не должно значить править приложение.
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

  const result = await asReportRole(async (db) => {
    const { rows: settings } = await db.query<FeedSettings>(
      "select * from app.feed_settings($1)",
      [token],
    );
    const channel = settings[0];
    if (!channel) return null;

    // Ненастроенный канал отвечает отказом, а не половинчатым фидом. Молча
    // отдать площадке объявления, по которым нельзя позвонить, хуже, чем не
    // отдать ничего: агентство будет думать, что выгрузка работает.
    if (!channel.ready) {
      return { error: channel.not_ready_reason ?? "канал не настроен" };
    }

    const { rows } = await db.query<FeedItem>(
      "select * from app.channel_feed($1::publication_channel)",
      [channel.channel],
    );

    const xml = buildFeed(channel, rows, new Date());

    // Запись об обращении — единственное доказательство, что выгрузка живёт.
    // Пишется после сборки: если сборка упала, записи быть не должно.
    await db.query("select app.record_channel_fetch($1::publication_channel, $2, $3)", [
      channel.channel,
      rows.length,
      Buffer.byteLength(xml, "utf8"),
    ]);

    return { xml };
  });

  if (result === null) {
    // Неизвестный или отключённый токен отвечает тем же, чем мусор в адресе:
    // по ответу нельзя отличить «такого канала нет» от «канал выключен».
    return new Response("не фид\n", { status: 404 });
  }

  if ("error" in result) {
    return new Response(`канал не настроен: ${result.error}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(result.xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // Фид отдаётся площадке, а не человеку, и кэшировать его посредникам
      // незачем: объект, снятый с публикации, обязан исчезнуть сразу.
      "cache-control": "no-store",
    },
  });
}
