import {
  claimNotifications, enqueueDueReminders, markNotification,
} from '@/lib/db/notifications';
import { idleRequests, markRequestNudged } from '@/lib/db/requests';
import { sweepExpired } from '@/lib/db/session';
import { expireMandates } from '@/lib/db/mandates';
import { denyCron } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Рассылка напоминаний о задачах. Вызывается по расписанию.
 *
 * Решение о том, что и кому напомнить, принимает слой доступа
 * (lib/db/notifications.ts), здесь только доставка. Разделение не
 * формальное: решение проверяемо тестами, доставка — нет.
 *
 * Маршрут ходит в базу БЕЗ сессии агента, то есть мимо проверок прав,
 * поэтому он закрыт секретом. Если секрет не задан — маршрут отказывает,
 * а не открывается: незаданный секрет это не «проверка выключена», это
 * ошибка настройки.
 *
 * Здесь же делается остальная работа по расписанию: гашение просроченных
 * мандатов и уборка протухших сессий и ссылок входа. Одно расписание на
 * всё — потому что все три задачи идемпотентны и дешёвы, а отдельное
 * расписание на каждую пришлось бы заводить и помнить.
 */

async function sendTelegram(chatId: number, text: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return 'TELEGRAM_BOT_TOKEN не задан';

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
    });

    if (res.ok) return null;

    // Описание ошибки от Telegram полезно в last_error, но токен в тексте
    // ответа не встречается, поэтому записывать его безопасно.
    const detail = await res.text();
    return `Telegram ответил ${res.status}: ${detail.slice(0, 200)}`;
  } catch (e) {
    return `не удалось отправить: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`;
  }
}

export async function GET(request: Request) {
  const denied = denyCron(request);
  if (denied) {
    return Response.json({ error: denied }, { status: 401 });
  }

  // Истёкшие мандаты. Инвариант 1 держится датой, а дата сама себя не
  // проверяет: без этого вызова объект остаётся в каталоге с просроченным
  // договором.
  let expired = 0;
  try {
    expired = await expireMandates();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка гашения мандатов' },
      { status: 500 },
    );
  }

  // Уборка протухшего. Просроченные строки и так не пускают — проверка по
  // сроку стоит в запросе, — но без уборки таблицы растут вечно.
  const swept = await sweepExpired().catch(() => ({ sessions: 0, tokens: 0 }));

  // 1. Решаем, о чём напоминать. Идемпотентно: повторный вызов расписания
  //    дубликатов не создаёт.
  let queued = 0;
  try {
    queued = await enqueueDueReminders();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка постановки в очередь' },
      { status: 500 },
    );
  }

  // 2. Забираем пачку. Статус «в отправке» ставится при выдаче, поэтому
  //    одновременный второй вызов те же записи не возьмёт.
  let rows: Array<{
    id: string; channel: string | null; body: string; telegram_id: number | null;
  }> = [];
  try {
    rows = await claimNotifications(50);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка выдачи' },
      { status: 500 },
    );
  }

  let sent = 0;
  let failed = 0;
  const reasons: Record<string, number> = {};

  for (const row of rows) {
    let error: string | null;

    if (row.channel === 'telegram' && row.telegram_id) {
      error = await sendTelegram(row.telegram_id, row.body);
    } else {
      error = 'канал доставки не определён';
    }

    if (error) {
      failed++;
      reasons[error] = (reasons[error] ?? 0) + 1;
    } else {
      sent++;
    }

    // Отчитываемся по каждой записи отдельно: падение на середине не теряет
    // уже отправленное и не отправляет повторно.
    await markNotification(row.id, error === null, error);
  }

  // Застоявшиеся заявки. Своей очереди у них нет — она жёстко привязана к
  // активностям, — но доставка общая: тот же sendTelegram, что и выше.
  // Второй копии отправки здесь не появилось, и появляться ей незачем.
  let nudged = 0;
  let nudgeFailed = 0;

  try {
    for (const nudge of await idleRequests()) {
      const error = await sendTelegram(nudge.telegram_id, nudge.body);
      if (error) {
        nudgeFailed++;
        reasons[error] = (reasons[error] ?? 0) + 1;
        // Отметку НЕ ставим: неудачная отправка не должна закрывать
        // заявку от следующего прогона.
        continue;
      }
      await markRequestNudged(nudge.request_id);
      nudged++;
    }
  } catch (e) {
    reasons[e instanceof Error ? e.message : 'заявки не проверены'] =
      (reasons['заявки не проверены'] ?? 0) + 1;
  }

  return Response.json({
    expired_mandates: expired,
    swept,
    queued,
    claimed: rows.length,
    sent,
    failed,
    nudged,
    nudge_failed: nudgeFailed,
    reasons,
  });
}
