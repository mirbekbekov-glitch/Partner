import 'server-only';
import { all, newId, now, one, run } from './sql';

/**
 * Что ушло в фид и кто его забирал.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ПОНАДОБИЛОСЬ. Кабинет не знал, опубликован ли объект
 * на площадке. Таблица publication_channels для этого заведена с самого
 * начала, но писал в неё НИКТО: отметки только снимались. Ответить на
 * вопрос «наше объявление уже на house.kg?» можно было, лишь сходив туда
 * руками, — что я и делал.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, А ЧТО НЕТ. Три разных утверждения:
 *
 *   «объект попал в выгрузку» — наш факт, знаем точно;
 *   «площадка забрала фид»    — тоже наш факт: запрос пришёл к нам;
 *   «объявление опубликовано» — НЕ НАШ факт, и мы его не утверждаем.
 *
 * Последнее знает только площадка. Пока она не сообщает нам ничего — ни
 * идентификатора объявления, ни отказа, — написать «опубликовано» значило
 * бы дать обещание за чужой счёт. Карточка объекта говорит первое и
 * второе.
 */

export type FeedChannel = 'house_kg' | 'yandex';

/**
 * Не чаще раза в десять минут на один фид.
 *
 * Фид открыт всем: его дёргают поисковые роботы, проверялки ссылок и
 * любопытные. Писать на каждый запрос значило бы отдать публичному
 * адресу право нагружать базу. Десять минут совпадают с заголовком
 * кэширования самого фида — чаще его и пересобирать незачем.
 */
const PULL_THROTTLE_MS = 10 * 60 * 1000;

/** Записать, что фид забрали. Возвращает true, если запись случилась. */
export async function recordPull(
  channel: FeedChannel,
  agent: string | null,
): Promise<boolean> {
  const at = now();
  const previous = await one<{ last_at: string }>(
    'select last_at from feed_pulls where channel = ?', channel,
  );

  if (previous && Date.parse(at) - Date.parse(previous.last_at) < PULL_THROTTLE_MS) {
    return false;
  }

  await run(
    `insert into feed_pulls (channel, last_at, last_agent, pulls)
     values (?, ?, ?, 1)
     on conflict (channel) do update
        set last_at = excluded.last_at,
            last_agent = excluded.last_agent,
            pulls = feed_pulls.pulls + 1`,
    channel, at, agent?.slice(0, 200) ?? null,
  );
  return true;
}

/** Когда фид забирали в последний раз. */
export async function lastPull(channel: FeedChannel): Promise<
  { last_at: string; last_agent: string | null; pulls: number } | null
> {
  return one<{ last_at: string; last_agent: string | null; pulls: number }>(
    'select last_at, last_agent, pulls from feed_pulls where channel = ?', channel,
  );
}

/**
 * Отметить объекты, попавшие в выгрузку.
 *
 * Двумя запросами на весь список, а не запросом на объект: фид
 * пересобирается на каждый запрос площадки, и сотня объектов означала бы
 * сотню записей в базу за один чужой заход.
 *
 * Канал 'yandex' в publication_channels не предусмотрен — там свой
 * список значений, заведённый до нас. Для него отметка на объекте не
 * ставится; хватает записи о том, что фид забирали.
 */
export async function markExported(objectIds: string[]): Promise<number> {
  if (objectIds.length === 0) return 0;

  const at = now();
  let marked = 0;

  for (let i = 0; i < objectIds.length; i += 50) {
    const chunk = objectIds.slice(i, i + 50);
    const holders = chunk.map(() => '?').join(', ');

    // Заводим недостающие связи. Идентификаторы генерирует код: своего
    // умолчания у колонки нет, как и у всех остальных таблиц проекта.
    const existing = await all<{ object_id: string }>(
      `select object_id from publication_channels
        where channel = 'house_kg' and object_id in (${holders})`,
      ...chunk,
    );
    const known = new Set(existing.map((r) => r.object_id));

    for (const id of chunk) {
      if (known.has(id)) continue;
      await run(
        `insert into publication_channels
           (id, object_id, channel, status, last_sync_at, created_at, updated_at)
         values (?, ?, 'house_kg', 'exported', ?, ?, ?)`,
        newId(), id, at, at, at,
      );
      marked++;
    }

    // Уже известные — обновляем отметку и поднимаем статус обратно, если
    // объект когда-то снимали с публикации, а теперь он снова в выгрузке.
    marked += await run(
      `update publication_channels
          set status = 'exported', last_sync_at = ?, updated_at = ?
        where channel = 'house_kg' and object_id in (${holders})`,
      at, at, ...chunk,
    );
  }

  return marked;
}

/** Что известно о выгрузке одного объекта — для его карточки. */
export async function exportState(objectId: string): Promise<{
  exportedAt: string | null;
  status: string | null;
  lastPullAt: string | null;
}> {
  const row = await one<{ last_sync_at: string | null; status: string }>(
    `select last_sync_at, status from publication_channels
      where object_id = ? and channel = 'house_kg'`,
    objectId,
  );
  const pull = await lastPull('house_kg');

  return {
    exportedAt: row?.last_sync_at ?? null,
    status: row?.status ?? null,
    lastPullAt: pull?.last_at ?? null,
  };
}
