import { objectList } from '@/lib/db/cabinet';
import { parseFilters } from '@/lib/list-params';
import { csvResponse, toCsv } from '@/lib/csv';
import { exportFailed, EXPORT_LIMIT } from '../../export-response';

/**
 * Выгрузка объектов в CSV.
 *
 * Берёт ТЕ ЖЕ фильтры и ту же функцию, что и страница: иначе файл
 * разошёлся бы с тем, что агент видит на экране, и спорить об этом было
 * бы нечем.
 *
 * Видимость не ослаблена: имя собственника закрывает инвариант 4 в самом
 * запросе, и в файл попадает ровно то, что попало бы на экран. Выгрузка —
 * другой способ посмотреть, а не способ обойти.
 */
export const dynamic = 'force-dynamic';

const STATE_RU: Record<string, string> = {
  draft: 'черновик',
  published: 'опубликован',
  withdrawn: 'снят',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const f = parseFilters(Object.fromEntries(url.searchParams.entries()));

  const source = f.src === 'me' ? 'mine'
    : f.src === 'org' ? 'org'
    : f.src === 'other' ? 'others'
    : 'all';
  const agentId = f.src && f.src.includes('-') ? f.src : null;

  try {
    const { rows } = await objectList({
      state: f.state, deal: f.deal, zone: f.zone, q: f.q,
      source, agentId, sort: f.sort, dir: f.dir,
      page: 1, perPage: EXPORT_LIMIT,
    });

    const csv = toCsv(
      ['Адрес', 'Сделка', 'Состояние', 'Цена', 'Валюта', 'Комиссия',
       'Подборов', 'Зона', 'Комнат', 'Площадь', 'Этаж', 'Собственник',
       'Ведёт', 'Агентство', 'Актуально'],
      rows.map((o) => [
        o.address,
        o.deal_type === 'sale' ? 'продажа' : 'аренда',
        STATE_RU[o.publication_state] ?? o.publication_state,
        o.price,
        o.currency,
        o.commission_total,
        o.matches_count,
        o.zone,
        o.rooms,
        o.area,
        o.floor,
        // Закрытый контакт помечается словом, а не пустотой: пустая ячейка
        // читается как «собственника нет», а он есть — просто не ваш.
        o.owner_name ?? 'скрыт',
        o.responsible_name,
        o.responsible_org_name ?? 'частный агент',
        o.actual_at,
      ]),
    );

    return csvResponse('objects', csv);
  } catch (e) {
    return exportFailed(e);
  }
}
