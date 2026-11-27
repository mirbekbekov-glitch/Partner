import { feedXml } from '@/lib/feed';
import { recordPull } from '@/lib/db/feed-log';

/**
 * Фид объявлений: постоянный адрес для площадок.
 *
 * Адрес отдаётся из самого запроса, а не из настройки. Сменится домен —
 * ссылки внутри фида сменятся вместе с ним, и объявления не станут
 * указывать в пустоту.
 *
 * Заход площадки записывается, но отметки на объектах — нет: в
 * publication_channels у каналов свой список значений, заведённый до
 * нас, и 'yandex' в него не входит. Выдумывать значение ради симметрии
 * не стали: запись о заходе отвечает на вопрос «читают ли нас вообще»,
 * а это здесь и нужно.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { origin } = new URL(request.url);

  const xml = await feedXml(origin);

  try {
    await recordPull('yandex', request.headers.get('user-agent'));
  } catch (e) {
    console.error('feed.xml: не записали заход площадки —', e);
  }

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Площадки читают фид раз в сутки, но проверять могут чаще. Десять
      // минут — чтобы частый опрос не пересобирал файл каждый раз.
      'cache-control': 'public, max-age=600',
    },
  });
}
