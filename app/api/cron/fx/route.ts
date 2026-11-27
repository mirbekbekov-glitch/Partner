import { refreshRates, knownRates } from '@/lib/db/fx';
import { denyCron } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Курс Нацбанка. Вызывается по расписанию, раз в сутки.
 *
 * Отдельным маршрутом, как и перенос каталога: расписание общее, но имя
 * маршрута должно говорить, что он делает.
 *
 * Неудача подтягивания — НЕ ошибка маршрута. Нацбанк недоступен или
 * ответил непонятным — прежний курс остаётся в базе и продолжает
 * работать, а в ответе видно, сколько валют записалось: ноль означает
 * «курс сегодня не обновился», и по журналу расписания это видно сразу.
 * Отдавать пятисотую значило бы требовать вмешательства там, где система
 * справляется сама.
 */
export async function GET(request: Request) {
  const denied = denyCron(request);
  if (denied) return Response.json({ error: denied }, { status: 401 });

  const written = await refreshRates();
  return Response.json({ written, rates: await knownRates() });
}
