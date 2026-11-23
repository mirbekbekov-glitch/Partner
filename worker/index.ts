/**
 * Точка входа Worker: запросы и расписание.
 *
 * На Vercel рассылку напоминаний будил cron из vercel.json — он просто
 * дёргал /api/cron/reminders по сети. На Cloudflare расписание устроено
 * иначе: платформа вызывает не URL, а функцию scheduled() прямо в Worker,
 * и отдельного HTTP-запроса снаружи не существует.
 *
 * Поэтому scheduled() собирает запрос сам и отдаёт его тому же обработчику,
 * что обслуживает живых посетителей. Маршрут при этом остаётся обычным
 * маршрутом: его по-прежнему можно дёрнуть руками, он по-прежнему проверяет
 * секрет, и вся работа с service_role остаётся внутри app/api, как того
 * требует инвариант 4. Никакой второй копии логики рассылки здесь нет —
 * копия рано или поздно разошлась бы с оригиналом.
 */
import handler from 'vinext/server/fetch-handler';

export default {
  fetch: handler.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: { CRON_SECRET?: string },
    ctx: ExecutionContext,
  ): Promise<void> {
    const secret = env.CRON_SECRET;

    // Пустой секрет — ошибка настройки, а не выключенная проверка: маршрут
    // в таком случае откажет сам. Говорим об этом в журнал и выходим, чтобы
    // в логах не копился невнятный 401 раз в сутки.
    if (!secret) {
      console.error('расписание: CRON_SECRET не задан, рассылка пропущена');
      return;
    }

    const request = new Request('https://cron.internal/api/cron/reminders', {
      headers: { authorization: `Bearer ${secret}` },
    });

    const response = await handler.fetch(request, env, ctx);
    const body = await response.text();

    // Итог в журнал: сколько разослано и сколько не ушло. Без этого
    // «молчащее» расписание неотличимо от работающего.
    if (response.ok) {
      console.log('расписание: напоминания разосланы —', body);
    } else {
      console.error(`расписание: ответ ${response.status} —`, body);
    }
  },
};
