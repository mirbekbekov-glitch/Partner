import { mhouseOffers } from '@/lib/mhouse-feed';
import { markExported, recordPull } from '@/lib/db/feed-log';

/**
 * Фид для MHouse: постоянный адрес, который партнёр отдаёт площадке.
 *
 * Отдельный адрес от /feed.xml, потому что отдельный формат. Площадке
 * сообщается именно он — один адрес на одну площадку, как она и просит.
 *
 * Адрес берётся из самого запроса, а не из настройки: сменится домен —
 * ссылки внутри фида сменятся вместе с ним.
 *
 * ЗДЕСЬ ЖЕ ЗАПИСЫВАЕТСЯ, ЧТО ФИД ЗАБРАЛИ. Другого места для этого нет:
 * площадка приходит сама, и сам факт её прихода — единственное, что мы о
 * ней знаем. Без этой записи кабинет не мог ответить на вопрос «наше
 * объявление уже на house.kg?» вовсе.
 *
 * Запись не мешает отдаче: если она сорвалась, фид всё равно уходит.
 * Площадка пришла за объявлениями, а не за нашим журналом.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  const { xml, ids } = await mhouseOffers(origin);

  try {
    const fresh = await recordPull('house_kg', request.headers.get('user-agent'));
    // Отметки на объектах ставятся вместе с записью о заходе, то есть не
    // чаще раза в десять минут: фид открыт всем, и частый опрос не
    // должен превращаться в поток записей.
    if (fresh) await markExported(ids);
  } catch (e) {
    console.error('mhouse.xml: не записали заход площадки —', e);
  }

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Площадка читает фид не чаще раза в сутки, но проверять может
      // чаще. Десять минут — чтобы частый опрос не пересобирал файл.
      'cache-control': 'public, max-age=600',
    },
  });
}
