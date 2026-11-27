import { crawlMarket } from '@/lib/market/crawl';
import { denyCron } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Обход house.kg: наполнение индекса рынка. Вызывается по расписанию.
 *
 * Здесь только пропуск и ответ — решение о том, что брать и как считать,
 * принимают lib/market/* и lib/db/market.ts. То же разделение, что у
 * напоминаний и переноса каталога: решение проверяемо тестами, маршрут
 * нет.
 *
 * Недоступность площадки — НЕ ошибка маршрута. Отчёт в таком случае
 * честно говорит `unreachable: true` с кодом 200: чужой сайт не обязан
 * быть доступен, и будить этим ночную тревогу не за что. Ошибкой 500
 * остаётся только наша поломка.
 */
export async function GET(request: Request) {
  const denied = denyCron(request);
  if (denied) return Response.json({ error: denied }, { status: 401 });

  try {
    const report = await crawlMarket();
    return Response.json(report);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка обхода площадки' },
      { status: 500 },
    );
  }
}
