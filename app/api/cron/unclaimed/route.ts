import { unclaimedRequests, markUnclaimedNudged } from '@/lib/db/requests';
import { denyCron } from '@/lib/cron-auth';
import { sendTelegram } from '@/lib/telegram-send';

export const dynamic = 'force-dynamic';

/**
 * Непринятые заявки. Вызывается ЧАСТЫМ расписанием, каждые 15 минут.
 *
 * Отдельным маршрутом от суточного, и это не вкусовщина: в суточный
 * прогон входят курс Нацбанка и перенос каталога, которые ходят наружу.
 * Дёргать их каждые четверть часа значило бы молотить чужие сервера без
 * нужды. Здесь только один запрос в свою же базу.
 *
 * Решение — в слое доступа, доставка здесь. Отметка ставится ПОСЛЕ
 * успешной отправки хотя бы одному получателю: пометить до отправки
 * значило бы потерять заявку навсегда, если Telegram ответил ошибкой.
 */
export async function GET(request: Request) {
  const denied = denyCron(request);
  if (denied) return Response.json({ error: denied }, { status: 401 });

  const digest = await unclaimedRequests();
  if (!digest) return Response.json({ requests: 0, sent: 0 });

  let sent = 0;
  const reasons: Record<string, number> = {};

  for (const to of digest.recipients) {
    const error = await sendTelegram(to.telegram_id, digest.body);
    if (error) reasons[error] = (reasons[error] ?? 0) + 1;
    else sent++;
  }

  // Хотя бы один получил — заявки отмечены. Иначе следующий прогон
  // повторит: лучше второе сообщение, чем ни одного.
  if (sent > 0) await markUnclaimedNudged(digest.request_ids);

  return Response.json({
    requests: digest.request_ids.length,
    recipients: digest.recipients.length,
    sent,
    reasons,
  });
}
