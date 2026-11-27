import { importCatalog } from '@/lib/db/catalog-import';
import { denyCron } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Перенос объявлений старого сайта. Вызывается по расписанию.
 *
 * Решение о том, что переносить, принимают lib/catalog-csv.ts (разбор) и
 * lib/db/catalog-import.ts (запись) — здесь только пропуск и ответ. То же
 * разделение, что у напоминаний: решение проверяемо тестами, маршрут нет.
 *
 * Отдельным маршрутом, а не внутри /api/cron/reminders: расписание у них
 * общее, но имя маршрута должно говорить, что он делает. Прогон дешёвый —
 * один запрос в чужую базу и разбор файла на триста строк.
 */
export async function GET(request: Request) {
  const denied = denyCron(request);
  if (denied) return Response.json({ error: denied }, { status: 401 });

  try {
    const report = await importCatalog();
    return Response.json(report);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка переноса каталога' },
      { status: 500 },
    );
  }
}
