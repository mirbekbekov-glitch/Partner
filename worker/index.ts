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

    // Три дела по одному расписанию: разослать напоминания, перенести
    // объявления старого сайта и обойти площадку. Отдельного расписания
    // им не нужно — все суточные, — но маршрут у каждого свой: имя
    // маршрута должно говорить, что он делает.
    //
    // Обход площадки стоит ПОСЛЕДНИМ, и это не вкусовщина. Он самый
    // долгий (десятки запросов к чужому сайту с паузами) и самый
    // ненадёжный: чужой сайт вправе не ответить. Напоминания от этого
    // зависеть не должны — агент обязан получить задачи на день, даже
    // когда house.kg лежит.
    await run('/api/cron/reminders', 'напоминания', secret, env, ctx);
    await run('/api/cron/catalog-import', 'перенос каталога', secret, env, ctx);
    await run('/api/cron/market', 'обход площадки', secret, env, ctx);
  },
};

/**
 * Один маршрут расписания: дёрнуть и записать итог.
 *
 * Итог в журнал обязателен: без него «молчащее» расписание неотличимо от
 * работающего. Отказ одного дела не отменяет второго — они независимы.
 */
async function run(
  path: string,
  what: string,
  secret: string,
  env: unknown,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    const request = new Request(`https://cron.internal${path}`, {
      headers: { authorization: `Bearer ${secret}` },
    });

    const response = await handler.fetch(request, env, ctx);
    const body = await response.text();

    if (response.ok) console.log(`расписание: ${what} —`, body);
    else console.error(`расписание: ${what}, ответ ${response.status} —`, body);
  } catch (e) {
    console.error(`расписание: ${what} сорвалось —`, e instanceof Error ? e.message : e);
  }
}
