import 'server-only';
import { all, holders, jsonArray, one } from './sql';
import { searchText } from './normalize';
import { fromMinor } from './money';
import { MONTH_DAYS } from '../space-types';
import { panoramasFrom, type Panorama } from './panoramas';

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
  'id', 'kind', 'subkind', 'deal_type', 'term_days_min', 'term_days_max',
  'address', 'city', 'zone',
  'rooms', 'area', 'floor', 'floors_total',
  'price_minor', 'currency', 'photos', 'description',
  'published_at', 'actual_at',
  // Поля для выгрузки на площадки. Они публичны по смыслу: координаты,
  // серия дома и срок аренды — это то, что площадка показывает в самом
  // объявлении. Ничего о собственнике, агенте и комиссии здесь нет и быть
  // не может: такие колонки в этот список не попадают.
  'latitude', 'longitude', 'region', 'district', 'micro_district',
  'house_number', 'building_type', 'serie', 'land_area', 'rental_term',
  'commercial_type', 'room_location', 'parking_type', 'build_year',
  // Панорамы тура публичны по той же причине, что и снимки: их для того
  // и снимали. Подпись комнаты — единственное, что в них написано.
  'panoramas',
] as const;

const SELECT = COLUMNS.map((c) => `o.${c}`).join(', ');

export type CatalogRow = {
  id: string;
  kind: string;
  /** Точный вид внутри kind: кабинет, склад, рабочее место. */
  subkind: string | null;
  deal_type: 'rent' | 'sale';
  /** Срок аренды в днях: по нему отличается посуточное от долгого. */
  term_days_min: number | null;
  term_days_max: number | null;
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
  panoramas: string | null;
  description: string | null;
  published_at: string | null;
  actual_at: string;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  district: string | null;
  micro_district: string | null;
  house_number: string | null;
  building_type: string | null;
  serie: string | null;
  land_area: number | null;
  rental_term: string | null;
  commercial_type: string | null;
  room_location: string | null;
  parking_type: string | null;
  build_year: number | null;
};

/**
 * Карточка витрины для страницы.
 *
 * Кроме колонок базы здесь есть `price` — та же цена в основных единицах.
 * В базе деньги целые и минорные (см. money.ts), а в разметке цену
 * показывают человеку, и переводить её в каждом месте значило бы
 * размножить одно и то же деление по всем страницам.
 */
export type CatalogItem = Omit<CatalogRow, 'photos' | 'panoramas'> & {
  photos: string[];
  panoramas: Panorama[];
  price: number;
};

function view(row: CatalogRow): CatalogItem {
  return {
    ...row,
    photos: jsonArray<string>(row.photos),
    panoramas: panoramasFrom(row.panoramas),
    price: fromMinor(row.price_minor) ?? 0,
  };
}

/**
 * Что человек выбрал наверху: купить, снять, посуточно.
 *
 * «Посуточно» — не третий вид сделки, а срок: в базе это та же аренда.
 * Заводить ради него третье значение deal_type значило бы перестраивать
 * таблицу и делить надвое то, что в жизни одно: квартиру сдают и на
 * ночь, и на год, и это один и тот же объект.
 */
export type CatalogDeal = 'rent' | 'sale' | 'daily';

/**
 * Снять, не отсекая короткое.
 *
 * Отдельным флагом, а не четвёртым режимом: наверху вкладок три, и
 * четвёртая строка там появиться не должна. Это уточнение внутри
 * «Снять», и живёт оно в складке «ещё».
 */
export type CatalogTerm = 'any' | null;

/**
 * Условие отбора по выбранному режиму. Одно на все запросы витрины.
 *
 * «Посуточно» и «снять» — одна и та же аренда, разный срок. Объект
 * попадает в обе выдачи, если сдаётся и так и так: это правда о нём, а
 * не недосмотр отбора — квартиру сдают и на ночь, и на год.
 *
 * Объект без указанного срока считается долгосрочным. Так было до
 * появления срока, и прятать из основной выдачи объявления, заведённые
 * раньше, нельзя.
 *
 * Значение в текст запроса подставляется ЧИСЛОМ из кода, а не строкой
 * извне: MONTH_DAYS — наша константа, и внедрить через неё нечего.
 * Режим приходит снаружи, поэтому сверяется со списком, а не попадает
 * в запрос.
 */
function dealClause(
  deal: CatalogDeal | null | undefined,
  term?: CatalogTerm,
): string | null {
  // «Снять, срок неважен» — вся аренда целиком, вместе с хостелами.
  if (deal === 'rent' && term === 'any') return `o.deal_type = 'rent'`;
  if (deal === 'daily') {
    return `o.deal_type = 'rent' and o.term_days_min is not null
            and o.term_days_min < ${MONTH_DAYS}`;
  }
  if (deal === 'rent') {
    return `o.deal_type = 'rent'
            and (o.term_days_max is null or o.term_days_max > ${MONTH_DAYS})`;
  }
  if (deal === 'sale') return `o.deal_type = 'sale'`;
  return null;
}

export type CatalogQuery = {
  deal?: CatalogDeal | null;
  /** «any» во вкладке «Снять» — не отсекать короткий срок. */
  term?: CatalogTerm;
  kind?: string | null;
  city?: string | null;
  /** Города региона: фильтр по региону — это фильтр по его городам. */
  cities?: string[] | null;
  zone?: string | null;
  rooms?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  q?: string | null;
  /** Объекты одного агента — для его публичной страницы. */
  agent?: string | null;
  /**
   * Валюта, в которой человек смотрит цены, и курс к сому.
   *
   * Нужны отбору и порядку: без них «цена до» и «сначала дешёвые»
   * сравнивают числа разных валют. Пусто означает «курса нет» — тогда
   * сравниваются сырые числа, как было.
   */
  money?: 'USD' | 'KGS' | null;
  rate?: number | null;
  sort?: 'fresh' | 'cheap' | 'big';
  page?: number;
  pageSize?: number;
};

/**
 * Цена объекта, приведённая к сомам, — для отбора и порядка.
 *
 * Зачем приведение. Цены хранятся в своей валюте, и сравнивать их числом
 * нельзя: 80 000 сомов дешевле 2 000 долларов, но как числа — наоборот.
 * Пока весь каталог был в долларах, это не было видно; с первым объектом
 * в сомах «до 100 000» смешало бы несмешиваемое, а «сначала дешёвые»
 * поставило бы дорогое вперёд.
 *
 * К сомам, а не к долларам, потому что сом — валюта страны: объект без
 * курса (а курс бывает неизвестен) остаётся на своём месте, если он уже
 * в сомах, и это чаще верно, чем наоборот.
 *
 * Курс приходит параметром. Нет курса — приведения нет, и сравниваются
 * сырые числа: ровно то, что было до этого. Хуже не станет, а выдуманный
 * курс был бы хуже.
 */
function priceInSom(rate: number | null): string {
  if (!rate || rate <= 0) return 'o.price_minor';
  return `(case when o.currency = 'USD' then o.price_minor * ${Number(rate)}
                else o.price_minor end)`;
}

/** Поля сортировки. Имя колонки берётся отсюда, а не из строки запроса. */
function sorts(rate: number | null): Record<string, string> {
  return {
    // «Свежие» — по дате подтверждения, а не публикации: объявление, которое
    // агент подтвердил вчера, полезнее того, что висит с лета.
    fresh: 'o.actual_at desc',
    cheap: `${priceInSom(rate)} asc`,
    big: 'o.area desc',
  };
}

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

  const deal = dealClause(query.deal, query.term);
  if (deal) where.push(deal);
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

  // Цена приходит в основных единицах — так её вводит человек в фильтре,
  // и В ТОЙ ВАЛЮТЕ, которую он выбрал. Обе стороны сравнения приводятся к
  // сомам: иначе «до 100 000» у человека в сомах отрезало бы долларовые
  // объекты по их долларовому числу.
  const rate = query.rate && query.rate > 0 ? query.rate : null;
  const column = priceInSom(rate);
  const toSom = (v: number) =>
    rate && query.money === 'USD' ? v * 100 * rate : v * 100;

  if (query.priceMin != null) {
    where.push(`${column} >= ?`); params.push(toSom(query.priceMin));
  }
  if (query.priceMax != null) {
    where.push(`${column} <= ?`); params.push(toSom(query.priceMax));
  }

  // Объекты агента — через АКТИВНЫЙ мандат, как и везде в витрине: ведёт
  // объект тот, у кого договор, а не тот, кто завёл запись.
  if (query.agent) {
    where.push(`exists (select 1 from mandates m
                         where m.object_id = o.id and m.status = 'active'
                           and m.listing_agent_id = ?)`);
    params.push(query.agent);
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
  const table = sorts(query.rate ?? null);
  const order = table[query.sort ?? 'fresh'] ?? table.fresh!;

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
  deal?: CatalogDeal | null,
  city?: string | null,
  cities?: string[] | null,
  term?: CatalogTerm,
): Promise<Array<{ zone: string; n: number }>> {
  const params: (string | number)[] = [];
  const filters: string[] = [];
  // То же условие, что и в выдаче: иначе счётчик у района обещал бы
  // объявления, которых в выдаче нет.
  const clause = dealClause(deal, term);
  if (clause) filters.push(`and ${clause}`);
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
export type AgentContact = {
  /**
   * Телефон агента — ТЕПЕРЬ публичный.
   *
   * Раньше здесь его не было: звонок шёл в отдел продаж, чтобы объект не
   * уводили мимо агентства. Владелец площадки решил иначе: покупатель
   * говорит с тем, кто объект ведёт, а значит знает его. Прежний довод
   * никуда не делся — он просто перевешен в пользу скорости ответа.
   */
  phone: string | null;
  /** Мессенджеры — со слов агента: проверить их по номеру нельзя. */
  whatsapp: number;
  telegram_user: string | null;
};

export type CatalogAgent = AgentContact & {
  /**
   * Идентификатор нужен ссылке на страницу агента, и с её появлением он
   * перестал быть внутренним: он и так стоит в адресе `/agents/<id>`.
   * Держать его закрытым здесь, публикуя в адресе, было бы
   * непоследовательностью, а не защитой. Телефон, почта и статус
   * по-прежнему закрыты.
   */
  id: string;
  full_name: string;
  avatar_key: string | null;
  works_since: number | null;
  /** Уже проверенный админом. Непроверенного здесь не бывает. */
  certificate_no: string | null;
};

export async function catalogAgent(objectId: string): Promise<CatalogAgent | null> {
  return one<CatalogAgent>(
    `select ag.id, ag.full_name, ag.avatar_key, ag.works_since,
            ag.phone, ag.whatsapp, ag.telegram_user,
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
 * Агент для публичной страницы — тот же состав полей, что и на карточке
 * объекта, плюс агентство и число объектов.
 *
 * Агентство отдаётся ТОЛЬКО подтверждённое, по тому же правилу, что и
 * номер в реестре: принадлежность к фирме агент заявляет сам, и
 * непроверенное утверждение от имени агентства остаётся обманом.
 *
 * Телефон здесь есть, а почты нет: по почте в недвижимости не отвечают,
 * а вот звонок и сообщение в мессенджер — это и есть обращение. Почта
 * остаётся внутренним полем, как и статус.
 */
export type CatalogAgentCard = CatalogAgent & {
  id: string;
  organization: string | null;
  objects: number;
};

/**
 * Состав выдачи записан здесь один раз и используется обоими запросами —
 * списком и страницей одного агента. Два разных списка колонок однажды
 * разошлись бы, и поле, закрытое в одном месте, уехало бы наружу в другом.
 */
const AGENT_SELECT = `
  ag.id, ag.full_name, ag.avatar_key, ag.works_since,
  ag.phone, ag.whatsapp, ag.telegram_user,
  case when ag.certificate_confirmed = 1 then ag.certificate_no end
    as certificate_no,
  case when ag.org_confirmed = 1 then org.name end as organization,
  (select count(*) from mandates m
     join objects o on o.id = m.object_id
    where m.listing_agent_id = ag.id and m.status = 'active'
      and o.publication_state = 'published') as objects`;

/**
 * Условие «агента вообще видно клиенту».
 *
 * Одобрен — иначе на сайте оказался бы человек, которому ещё не открыли
 * доступ, или тот, кого выставили за дверь. И у него есть хотя бы один
 * опубликованный объект: страница агента без объектов это страница, на
 * которой нечего делать, а в списке — пустое обещание.
 */
const AGENT_VISIBLE = `
  ag.status = 'approved'
  and exists (select 1 from mandates m
                join objects o on o.id = m.object_id
               where m.listing_agent_id = ag.id and m.status = 'active'
                 and o.publication_state = 'published')`;

/** Агенты, которых видно клиенту. */
export async function catalogAgents(): Promise<CatalogAgentCard[]> {
  const rows = await all<CatalogAgentCard>(
    `select ${AGENT_SELECT}
       from agents ag
       left join organizations org on org.id = ag.organization_id
      where ${AGENT_VISIBLE}`,
  );

  // Порядок в коде: SQLite сравнивает строки побайтно, и для кириллицы
  // это значит, что все заглавные идут перед всеми строчными. Список
  // маленький и не постраничный, поэтому localeCompare здесь уместен.
  return rows.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));
}

/**
 * Сколько агентов видно клиенту — число для первого экрана.
 *
 * Отдельным запросом, а не длиной списка карточек: на первом экране нужно
 * одно число, а карточка тянет фотографию, стаж и организацию.
 */
export async function catalogAgentCount(): Promise<number> {
  const row = await one<{ n: number }>(
    `select count(*) as n from agents ag where ${AGENT_VISIBLE}`,
  );
  return row?.n ?? 0;
}

/** Один агент. Пусто означает «такого на сайте нет», и страница даёт 404. */
export async function catalogAgentById(id: string): Promise<CatalogAgentCard | null> {
  return one<CatalogAgentCard>(
    `select ${AGENT_SELECT}
       from agents ag
       left join organizations org on org.id = ag.organization_id
      where ag.id = ? and ${AGENT_VISIBLE}`,
    id,
  );
}

/**
 * Курс доллара для показа цен — через витрину, а не напрямую.
 *
 * Казалось бы, курс не тайна и читать его можно откуда угодно. Но правило
 * «публичная часть ходит только в витрину» держится проверкой, и дыра в
 * нём ради безобидного курса — это дыра. Завтра кто-то тем же приёмом
 * прочитает из публичной страницы кабинетный модуль, и проверка промолчит,
 * потому что однажды её уже обошли.
 *
 * Поэтому курс отдаётся отсюда. Состав тот же: сколько сомов за доллар и
 * на какую дату — дата обязана дойти до человека вместе с числом.
 */
export type CatalogRate = { som_per_unit: number; as_of: string };

export async function catalogRate(): Promise<CatalogRate | null> {
  return one<CatalogRate>(
    `select som_per_unit, as_of from fx_rates where code = 'USD'`,
  );
}

/**
 * Нижняя граница рынка для заявки клиента.
 *
 * Зачем. Человек пишет бюджет наугад: «сниму двушку в Асанбае за 20 000»,
 * когда дешевле 35 000 там нет ни одного варианта. Заявка уходит, агент
 * тратит день, клиент ждёт и злится — а разговор про деньги всё равно
 * состоится, только через день и уже на раздражении.
 *
 * ЧТО СЧИТАЕТСЯ ПОРОГОМ. Минимальная цена среди сопоставимых объявлений,
 * а не процентиль и не средняя со скидкой. Это единственная величина,
 * которую можно произнести вслух без вранья: «дешевле этого у нас нет ни
 * одного варианта». Процентиль отрезал бы людей, которым настоящее
 * объявление по карману, — а порог здесь ЗАПРЕЩАЕТ отправку, и запрещать
 * можно только то, что заведомо не существует.
 *
 * КОГДА ПОРОГА НЕТ. Когда сопоставимых объявлений меньше MIN_SAMPLE.
 * Запретить человеку заявку, опираясь на два объявления, — это запрет по
 * незнанию: рынок мы в этом срезе не знаем, и молчать честнее.
 *
 * Сравнимость: то же направление сделки, тот же вид жилья, тот же район.
 * Комнаты НЕ учитываются намеренно: разбиение ещё и по ним дробит выборку
 * до единиц, и порог исчезает там, где он нужнее всего.
 */
const MIN_SAMPLE = 5;

export type PriceFloor = {
  /** Минорные единицы, как в базе. */
  floor_minor: number;
  currency: string;
  /** По скольким объявлениям посчитано — это идёт человеку в подсказку. */
  based_on: number;
};

export async function priceFloor(query: {
  deal: 'rent' | 'sale';
  kind?: string | null;
  city?: string | null;
  zone?: string | null;
}): Promise<PriceFloor | null> {
  const where = [`o.publication_state = 'published'`, 'o.deal_type = ?'];
  const params: (string | number)[] = [query.deal];

  if (query.kind) { where.push('o.kind = ?'); params.push(query.kind); }
  if (query.city) { where.push('o.city = ?'); params.push(query.city); }
  if (query.zone) { where.push('o.zone = ?'); params.push(query.zone); }

  // Валюта берётся та, в которой выставлено большинство: смешивать цены
  // разных валют в одном минимуме нельзя, а пересчитывать здесь нечем —
  // курс в витрину приходит отдельно и может быть неизвестен.
  const row = await one<{ floor_minor: number; currency: string; based_on: number }>(
    `select min(o.price_minor) as floor_minor, o.currency as currency,
            count(*) as based_on
       from objects o
      where ${where.join(' and ')}
      group by o.currency
      order by count(*) desc
      limit 1`,
    ...params,
  );

  if (!row || row.based_on < MIN_SAMPLE || !row.floor_minor) return null;
  return row;
}

/**
 * Валюты, в которых выставлены опубликованные объекты.
 *
 * Нужны полю «цена до»: число без валюты непонятно — вводить 800 или
 * 70 000. Список, а не одно значение, потому что ответ бывает разный:
 * одна валюта — её и подписываем; несколько — подписать нечем, и это
 * честнее показать, чем выбрать за человека.
 */
export async function catalogCurrencies(): Promise<string[]> {
  const rows = await all<{ currency: string }>(
    `select distinct o.currency as currency from objects o
      where o.publication_state = 'published'
      order by o.currency`,
  );
  return rows.map((r) => r.currency);
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
