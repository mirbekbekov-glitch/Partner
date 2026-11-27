import 'server-only';
import { all, holders, jsonArray, one } from './sql';
import { searchText } from './normalize';
import { fromMinor } from './money';

/**
 * Публичный каталог — витрина.
 *
 * ЧТО СЮДА НЕ ПОПАДАЕТ: агент, агентство, собственник, контакты, комиссия,
 * мандат. Не из вежливости, а по устройству: страницы каталога ходят
 * только сюда, и колонок, которых здесь нет, они физически не получат.
 *
 * В Postgres это держало представление public_catalog_v с жёстким списком
 * колонок. Здесь список колонок записан один раз — в COLUMNS ниже, — и
 * каждый запрос модуля собирается из него. Добавить «ведёт» в выдачу можно
 * только дописав колонку сюда, а это видно в рецензии и ловится проверкой.
 *
 * Отдельный модуль от кабинетных запросов — намеренно. Общий слой рано или
 * поздно протащил бы кабинетное поле в публичный запрос.
 */

/** Единственный разрешённый состав публичной выдачи. */
const COLUMNS = [
  'id', 'kind', 'deal_type', 'address', 'city', 'zone',
  'rooms', 'area', 'floor', 'floors_total',
  'price_minor', 'currency', 'photos', 'description',
  'published_at', 'actual_at',
] as const;

const SELECT = COLUMNS.map((c) => `o.${c}`).join(', ');

export type CatalogRow = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  city: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price_minor: number;
  currency: string;
  photos: string;
  description: string | null;
  published_at: string | null;
  actual_at: string;
};

/**
 * Карточка витрины для страницы.
 *
 * Кроме колонок базы здесь есть `price` — та же цена в основных единицах.
 * В базе деньги целые и минорные (см. money.ts), а в разметке цену
 * показывают человеку, и переводить её в каждом месте значило бы
 * размножить одно и то же деление по всем страницам.
 */
export type CatalogItem = Omit<CatalogRow, 'photos'> & {
  photos: string[];
  price: number;
};

function view(row: CatalogRow): CatalogItem {
  return {
    ...row,
    photos: jsonArray<string>(row.photos),
    price: fromMinor(row.price_minor) ?? 0,
  };
}

export type CatalogQuery = {
  deal?: 'rent' | 'sale' | null;
  kind?: string | null;
  city?: string | null;
  /** Города региона: фильтр по региону — это фильтр по его городам. */
  cities?: string[] | null;
  zone?: string | null;
  rooms?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  q?: string | null;
  sort?: 'fresh' | 'cheap' | 'big';
  page?: number;
  pageSize?: number;
};

/** Поля сортировки. Имя колонки берётся отсюда, а не из строки запроса. */
const SORTS: Record<string, string> = {
  // «Свежие» — по дате подтверждения, а не публикации: объявление, которое
  // агент подтвердил вчера, полезнее того, что висит с лета.
  fresh: 'o.actual_at desc',
  cheap: 'o.price_minor asc',
  big: 'o.area desc',
};

/**
 * Разбор поискового запроса.
 *
 * Запрос бьётся на слова, и каждое должно найтись в тексте поиска объекта.
 * И запрос, и текст объекта проходят через одну и ту же searchText(),
 * поэтому «чуй» находит «Чүй», а «ЧҮЙ» находит «чуй»: оба приводятся к
 * одному виду ДО сравнения. Полагаться на lower() в запросе нельзя — в
 * SQLite он работает только с латиницей.
 *
 * Запятая здесь не разделитель между запросом и мусором, а обычный
 * пробел: «Чүй, кв» это два слова. На Postgres она однажды роняла весь
 * запрос целиком, и человек видел пустой каталог.
 */
function searchTerms(q: string): string[] {
  return searchText(q)
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 6);
}

export type CatalogPage = { items: CatalogItem[]; total: number };

/**
 * Условия выборки — одни и те же для выдачи и для счётчика.
 *
 * Имена колонок берутся из кода, значения уходят параметрами. Подставлять
 * пришедшее снаружи в текст запроса нельзя даже «своё»: ровно так
 * появляются внедрения SQL.
 */
function conditions(query: CatalogQuery): { clause: string; params: (string | number)[] } {
  const where: string[] = [`o.publication_state = 'published'`];
  const params: (string | number)[] = [];

  if (query.deal) { where.push('o.deal_type = ?'); params.push(query.deal); }
  if (query.kind) { where.push('o.kind = ?'); params.push(query.kind); }
  if (query.city) { where.push('o.city = ?'); params.push(query.city); }
  // Региона в базе нет и быть не должно: регион — это свойство города,
  // а не объекта, и храни мы его в карточке, он разошёлся бы с городом
  // в первый же день. Поэтому регион превращается в список городов.
  else if (query.cities && query.cities.length > 0) {
    where.push(`o.city in (${query.cities.map(() => '?').join(', ')})`);
    params.push(...query.cities);
  }
  if (query.zone) { where.push('o.zone = ?'); params.push(query.zone); }
  if (query.rooms) { where.push('o.rooms = ?'); params.push(query.rooms); }

  // Цена приходит в основных единицах — так её вводит человек в фильтре.
  if (query.priceMin != null) {
    where.push('o.price_minor >= ?'); params.push(query.priceMin * 100);
  }
  if (query.priceMax != null) {
    where.push('o.price_minor <= ?'); params.push(query.priceMax * 100);
  }

  if (query.q) {
    for (const word of searchTerms(query.q)) {
      where.push('o.search_text like ?');
      params.push(`%${word}%`);
    }
  }

  return { clause: where.join(' and '), params };
}

/** Список объектов витрины. */
export async function catalogPage(query: CatalogQuery = {}): Promise<CatalogPage> {
  const { clause, params } = conditions(query);
  const order = SORTS[query.sort ?? 'fresh'] ?? SORTS.fresh;

  const size = Math.min(Math.max(query.pageSize ?? 12, 1), 60);
  const page = Math.max(query.page ?? 1, 1);

  const counted = await one<{ n: number }>(
    `select count(*) as n from objects o where ${clause}`, ...params,
  );

  const rows = await all<CatalogRow>(
    `select ${SELECT} from objects o where ${clause}
      order by ${order} limit ? offset ?`,
    ...params, size, (page - 1) * size,
  );

  return { items: rows.map(view), total: counted?.n ?? 0 };
}

/**
 * Сколько объектов найдётся по этим условиям.
 *
 * Отдельно от catalogPage(), потому что считает ТЕ ЖЕ условия, но не тянет
 * строки: число на кнопке «Найти 12» нужно до выдачи. Условия собираются
 * одной функцией с выдачей — иначе число на кнопке разошлось бы с тем, что
 * человек увидит, а это хуже, чем отсутствие числа.
 */
export async function catalogCount(query: CatalogQuery = {}): Promise<number> {
  const { clause, params } = conditions(query);
  const counted = await one<{ n: number }>(
    `select count(*) as n from objects o where ${clause}`, ...params,
  );
  return counted?.n ?? 0;
}

/**
 * Одна карточка витрины.
 *
 * Черновик и снятый объект отдают НИЧЕГО, а не устаревшую цену: страница
 * обязана ответить 404. Это же закрывает выяснение существования черновика
 * по прямой ссылке.
 */
export async function catalogObject(id: string): Promise<CatalogItem | null> {
  const row = await one<CatalogRow>(
    `select ${SELECT} from objects o
      where o.id = ? and o.publication_state = 'published'`,
    id,
  );
  return row ? view(row) : null;
}

/** Идентификаторы опубликованных объектов — для карты сайта. */
export async function publishedIds(): Promise<Array<{ id: string; actual_at: string }>> {
  return all(
    `select o.id, o.actual_at from objects o
      where o.publication_state = 'published' order by o.actual_at desc limit 5000`,
  );
}

/** Районы для фильтра. Справочник публичен: он и так виден в адресах. */
export async function districts(): Promise<Array<{ id: string; name: string }>> {
  return all(
    `select id, name from districts where active = 1 order by sort, name`,
  );
}

/**
 * Районы с числом объектов — для строки районов и схемы под каталогом.
 *
 * Пустой район показывать нельзя: нажатие на него обманет человека и
 * приведёт в пустой каталог. Поэтому считаем, а не перечисляем.
 *
 * Считается по выбранному ГОРОДУ. Без этого «Центр» складывал бы центр
 * Бишкека с центром Оша в одно число, а нажатие на него приводило бы в
 * список из двух разных городов. Пока город в базе был один, вопроса не
 * было; с появлением второго это стало прямой ложью в цифре.
 */
export async function catalogZoneCounts(
  deal?: 'rent' | 'sale' | null,
  city?: string | null,
  cities?: string[] | null,
): Promise<Array<{ zone: string; n: number }>> {
  const params: (string | number)[] = [];
  const filters: string[] = [];
  if (deal) { filters.push('and o.deal_type = ?'); params.push(deal); }
  if (city) { filters.push('and o.city = ?'); params.push(city); }
  else if (cities && cities.length > 0) {
    filters.push(`and o.city in (${cities.map(() => '?').join(', ')})`);
    params.push(...cities);
  }

  return all<{ zone: string; n: number }>(
    `select o.zone as zone, count(*) as n from objects o
      where o.publication_state = 'published' and o.zone is not null
        ${filters.join(' ')}
      group by o.zone order by n desc, o.zone`,
    ...params,
  );
}

/**
 * Агент, ведущий объект, — для публичной карточки.
 *
 * До сих пор витрина не отдавала об агенте НИЧЕГО, и это было правильно,
 * пока показывать было нечего. Теперь есть: лицо, стаж и сертификат.
 * Покупатель решает не только по квартире, но и по тому, с кем
 * разговаривать.
 *
 * Состав выдачи записан здесь списком и короче некуда. Телефона и почты
 * тут нет и не должно появиться: звонят через заявку, и это осознанный
 * порядок, а не недоделка. Идентификатора агента тоже нет — наружу он не
 * нужен, а по нему связываются чужие данные.
 *
 * Сертификат отдаётся ТОЛЬКО подтверждённый, и это решает запрос, а не
 * страница. Положись мы на страницу — однажды появилась бы вторая,
 * которая забыла проверить отметку, и непроверенное утверждение о
 * квалификации ушло бы клиенту от имени агентства.
 *
 * Агент берётся из АКТИВНОГО МАНДАТА, а не из того, кто завёл объект:
 * ведёт объект тот, у кого договор. Без мандата объект и не публикуется
 * (инвариант 1), так что пустой ответ здесь означает снятый объект.
 */
export type CatalogAgent = {
  full_name: string;
  avatar_key: string | null;
  works_since: number | null;
  /** Уже проверенный админом. Непроверенного здесь не бывает. */
  certificate_no: string | null;
};

export async function catalogAgent(objectId: string): Promise<CatalogAgent | null> {
  return one<CatalogAgent>(
    `select ag.full_name, ag.avatar_key, ag.works_since,
            case when ag.certificate_confirmed = 1 then ag.certificate_no end
              as certificate_no
       from objects o
       join mandates m on m.object_id = o.id and m.status = 'active'
       join agents ag on ag.id = m.listing_agent_id
      where o.id = ? and o.publication_state = 'published'`,
    objectId,
  );
}

/**
 * Города, которые реально встречаются в опубликованных объектах.
 *
 * Нужны фильтру, и по ним же он решает, показываться ли вовсе: пока
 * город один, выбор из одного пункта — лишняя деталь на экране. Поэтому
 * список, а не признак «есть ли города»: странице нужно и то и другое.
 */
export async function catalogCities(): Promise<string[]> {
  const rows = await all<{ city: string }>(
    `select distinct o.city as city from objects o
      where o.publication_state = 'published'
      order by o.city`,
  );
  return rows.map((r) => r.city);
}

/** Зоны, которые реально встречаются в опубликованных объектах. */
export async function catalogZones(): Promise<string[]> {
  const rows = await all<{ zone: string }>(
    `select distinct o.zone as zone from objects o
      where o.publication_state = 'published' and o.zone is not null
      order by o.zone`,
  );
  return rows.map((r) => r.zone);
}

export { holders };
