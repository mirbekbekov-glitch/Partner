import { feedXml } from '@/lib/feed';

/**
 * Фид объявлений: постоянный адрес для площадок.
 *
 * Адрес отдаётся из самого запроса, а не из настройки. Сменится домен —
 * ссылки внутри фида сменятся вместе с ним, и объявления не станут
 * указывать в пустоту.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { origin } = new URL(request.url);

  return new Response(await feedXml(origin), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Площадки читают фид раз в сутки, но проверять могут чаще. Десять
      // минут — чтобы частый опрос не пересобирал файл каждый раз.
      'cache-control': 'public, max-age=600',
    },
  });
}
