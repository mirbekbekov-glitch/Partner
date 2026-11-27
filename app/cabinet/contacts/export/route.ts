import { contactList } from '@/lib/db/cabinet';
import { parseFilters } from '@/lib/list-params';
import { csvResponse, toCsv } from '@/lib/csv';
import { ROLE_RU } from '../ContactForm';
import { exportFailed, EXPORT_LIMIT } from '../../export-response';

/**
 * Выгрузка контактов в CSV.
 *
 * Чужие записи сюда не попадают вовсе: инвариант 4 отсекает их в запросе,
 * а не на странице. Выгрузка видит ровно то же, что и список.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const f = parseFilters(Object.fromEntries(url.searchParams.entries()));
  const role = f.role && f.role in ROLE_RU ? f.role : null;

  try {
    const { rows } = await contactList(
      f.q, f.sort, f.dir, 1, role, EXPORT_LIMIT,
    );

    const csv = toCsv(
      ['Имя', 'Тип', 'Роли', 'Телефоны', 'Telegram', 'Объектов',
       'Потребностей', 'В работе', 'Источник', 'Привёл'],
      rows.map((c) => [
        c.name,
        c.kind === 'company' ? 'компания' : 'человек',
        (c.roles ?? []).map((r) => ROLE_RU[r] ?? r).join(', '),
        c.phones,
        c.telegram,
        c.objects_count,
        c.requirements_count,
        c.open_requirements,
        c.source,
        c.mine ? 'вы' : c.owner_name,
      ]),
    );

    return csvResponse('contacts', csv);
  } catch (e) {
    return exportFailed(e);
  }
}
