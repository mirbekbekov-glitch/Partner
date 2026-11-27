import { requirementList } from '@/lib/db/cabinet';
import { parseFilters } from '@/lib/list-params';
import { csvResponse, toCsv } from '@/lib/csv';
import { exportFailed, EXPORT_LIMIT } from '../../export-response';

/**
 * Выгрузка потребностей в CSV.
 *
 * Те же фильтры и та же функция, что у страницы. Имя клиента закрывает
 * инвариант 4 в самом запросе: в файл попадает то же, что на экран.
 */
export const dynamic = 'force-dynamic';

const STATUS_RU: Record<string, string> = {
  new: 'новая',
  qualified: 'уточнена',
  in_showings: 'показы',
  in_deal: 'в сделке',
  closed: 'закрыта',
  lost: 'потеряна',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const f = parseFilters(Object.fromEntries(url.searchParams.entries()));

  try {
    const { rows } = await requirementList({
      status: f.status, deal: f.deal, zone: f.zone, q: f.q,
      sort: f.sort, dir: f.dir, page: 1, perPage: EXPORT_LIMIT,
    });

    const csv = toCsv(
      ['Бюджет от', 'Бюджет до', 'Сделка', 'Статус', 'Клиент', 'Ведёт',
       'Зоны', 'Комнат', 'Подборов', 'Показов', 'Сделок', 'Срок', 'Требования'],
      rows.map((r) => [
        r.budget_min,
        r.budget_max,
        r.deal_type === 'sale' ? 'покупка' : 'аренда',
        STATUS_RU[r.status] ?? r.status,
        r.client_name ?? 'скрыт',
        r.agent_name,
        (r.zones ?? []).join(', '),
        (r.rooms ?? []).join(', '),
        r.matches_count,
        r.showings_count,
        r.deals_count,
        r.deadline,
        r.requirements_text,
      ]),
    );

    return csvResponse('requirements', csv);
  } catch (e) {
    return exportFailed(e);
  }
}
