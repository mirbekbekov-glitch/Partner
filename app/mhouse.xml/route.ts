import { mhouseXml } from '@/lib/mhouse-feed';

/**
 * Фид для MHouse: постоянный адрес, который партнёр отдаёт площадке.
 *
 * Отдельный адрес от /feed.xml, потому что отдельный формат. Площадке
 * сообщается именно он — один адрес на одну площадку, как она и просит.
 *
 * Адрес берётся из самого запроса, а не из настройки: сменится домен —
 * ссылки внутри фида сменятся вместе с ним.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { origin } = new URL(request.url);

  return new Response(await mhouseXml(origin), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Площадка читает фид не чаще раза в сутки, но проверять может
      // чаще. Десять минут — чтобы частый опрос не пересобирал файл.
      'cache-control': 'public, max-age=600',
    },
  });
}
