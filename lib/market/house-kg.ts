/**
 * Чтение публичных объявлений house.kg: аналоги для оценки.
 *
 * ЗАЧЕМ. Оценка «по рынку» без рынка — это выдумка. Своя база агентства
 * мала: по редкой связке «район + комнаты + площадь» в ней найдётся два
 * объекта, а на двух объектах средней цены не бывает. Поэтому аналоги
 * берутся со страницы, где их тысячи.
 *
 * ОТКУДА ИМЕННО. Со страниц ПОИСКА — тех самых, что открывает человек в
 * браузере. Их внутренний /api/ закрыт в robots.txt, и мы туда не ходим:
 * запрет площадки — это её право, а не препятствие, которое надо обойти.
 * Одна страница поиска отдаёт 40 карточек, и в каждой уже есть всё, что
 * нужно оценке: комнаты, площадь, этаж, адрес, цена в сомах и долларах.
 * Поэтому ходить на 40 карточек объявления по отдельности не нужно — это
 * был бы сорокакратный трафик ради тех же чисел.
 *
 * РАЗБОР ЦЕНЫ — САМОЕ ОПАСНОЕ МЕСТО. В карточке три числа: цена в сомах,
 * цена в долларах и ПЛАТЁЖ ПО ИПОТЕКЕ «167 514 сом в мес». Перепутать
 * третье с первым — значит оценить квартиру в 167 тысяч сомов вместо 23
 * миллионов, и ошибка эта тихая: число выглядит правдоподобно. Поэтому
 * цена принимается, только когда ОБЕ валюты найдены и их отношение похоже
 * на настоящий курс (см. RATE_MIN/RATE_MAX). Платёж по ипотеке такой
 * проверки не проходит никогда: он к долларовой цене не относится вовсе.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Не ходит в базу и не знает о ней: разбор
 * отдельно, хранение отдельно. Благодаря этому разбор проверяется на
 * сохранённом снимке настоящей страницы (tests/fixtures/house-kg-search.html)
 * без сети и без базы.
 */

/** Одна карточка со страницы поиска. */
export type MarketCard = {
  /** Идентификатор объявления у площадки: часть адреса после /details/. */
  sourceId: string;
  url: string;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floorsTotal: number | null;
  /** Цена целыми долларами. */
  priceUsd: number;
  /** Цена целыми сомами. */
  priceKgs: number;
  address: string | null;
  /** Город из первой части адреса: «Бишкек, Медерова 44/2» → «Бишкек». */
  city: string | null;
  /** Площадка пометила объявление как поданное собственником. */
  byOwner: boolean;
};

/** Разбор страницы: что получилось и что отброшено, с причинами. */
export type ParseResult = {
  cards: MarketCard[];
  skipped: Record<string, number>;
};

/**
 * Границы правдоподобного курса сома к доллару.
 *
 * Нужны не для точности курса, а чтобы отличить цену от платежа по
 * ипотеке. Курс держится около 87, и широкая вилка 60–130 переживёт любое
 * его движение, оставаясь при этом непроходимой для постороннего числа:
 * у платежа по ипотеке отношение выходит меньше единицы.
 */
const RATE_MIN = 60;
const RATE_MAX = 130;

/** Разумные границы цены в долларах: отсев опечаток площадки и «1 $». */
const PRICE_MIN_USD = 50;
const PRICE_MAX_USD = 20_000_000;

function countSkip(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** Текст без разметки: теги в пробелы, сущности — на место. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Число из записи вида «23 652 000» — с любыми пробелами внутри.
 *
 * Неразрывный пробел и узкий неразрывный площадка ставит наравне с
 * обычным; \s в JavaScript их покрывает, но запись оставлена явной, чтобы
 * правка не свелась к «убрать пробелы».
 */
function amount(raw: string): number | null {
  const digits = raw.replace(/[\s  ]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Заголовок карточки → комнаты, площадь, этажи.
 *
 * Площадка пишет его одной строкой: «2-комн. кв., 92 м², 5 этаж из 10».
 * У дома и участка состав другой — «участок, 8 соток», — поэтому каждая
 * часть необязательна, и её отсутствие не роняет карточку.
 */
export function parseTitle(title: string): {
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floorsTotal: number | null;
} {
  const rooms = title.match(/(\d+)\s*-?\s*комн/i);
  const area = title.match(/([\d.,]+)\s*м²/i);
  const floor = title.match(/(\d+)\s*этаж(?:\s*из\s*(\d+))?/i);

  const areaValue = area ? Number(area[1].replace(',', '.')) : null;

  return {
    rooms: rooms ? Number(rooms[1]) : null,
    area: areaValue !== null && Number.isFinite(areaValue) && areaValue > 0 ? areaValue : null,
    floor: floor ? Number(floor[1]) : null,
    floorsTotal: floor && floor[2] ? Number(floor[2]) : null,
  };
}

/**
 * Цены карточки: сомы и доллары.
 *
 * Берутся ВСЕ числа с валютным знаком, а потом выбирается та пара, что
 * похожа на курс. Привязываться к имени класса вёрстки нельзя: у площадки
 * классы вида `text-house-text-primary-text` собраны сборщиком и меняются
 * при каждой их пересборке, а отношение цен — свойство самих данных.
 */
export function parsePrices(cardHtml: string): { usd: number; kgs: number } | null {
  const flat = text(cardHtml);

  const kgsValues: number[] = [];
  for (const m of flat.matchAll(/([\d\s  ]{4,})\s*(?:⃀|сом)/gi)) {
    const value = amount(m[1]);
    if (value !== null) kgsValues.push(value);
  }

  const usdValues: number[] = [];
  for (const m of flat.matchAll(/([\d\s  ]{2,})\s*\$/g)) {
    const value = amount(m[1]);
    if (value !== null) usdValues.push(value);
  }

  for (const usd of usdValues) {
    if (usd < PRICE_MIN_USD || usd > PRICE_MAX_USD) continue;
    for (const kgs of kgsValues) {
      const rate = kgs / usd;
      if (rate >= RATE_MIN && rate <= RATE_MAX) return { usd, kgs };
    }
  }
  return null;
}

/** Адрес карточки → город и остальной адрес. */
export function splitAddress(line: string): { city: string | null; address: string } {
  const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { city: null, address: line.trim() };

  const city = parts[0];
  // Площадка иногда дублирует город: «Бишкек, Бишкек, Токомбаева 21/6».
  const rest = parts.slice(1).filter((p) => p !== city);
  return { city, address: rest.join(', ') || city };
}

/**
 * Разбор страницы поиска.
 *
 * Карточка — элемент <article>; внутри него ссылка на объявление, заголовок,
 * адрес и цены. Карточка, у которой не нашлось пары цен, ОТБРАСЫВАЕТСЯ с
 * причиной, а не попадает в выдачу с нулём: ноль в выборке аналогов сдвинул
 * бы медиану вниз молча.
 */
export function parseSearchPage(html: string): ParseResult {
  const cards: MarketCard[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();

  for (const match of html.matchAll(/<article\b[\s\S]*?<\/article>/g)) {
    const card = match[0];

    const link = card.match(/href="(\/details\/([^"?#]+))"/);
    if (!link) {
      countSkip(skipped, 'нет ссылки на объявление');
      continue;
    }
    const sourceId = link[2];
    if (seen.has(sourceId)) continue;

    const titleMatch = card.match(/href="\/details\/[^"]*"[^>]*>([^<]+)</);
    const title = titleMatch ? text(titleMatch[1]) : '';
    if (!title) {
      countSkip(skipped, 'нет заголовка');
      continue;
    }

    const prices = parsePrices(card);
    if (!prices) {
      countSkip(skipped, 'цена не распознана');
      continue;
    }

    const addressMatch = card.match(/aria-label="([^"]+)"/);
    const { city, address } = splitAddress(addressMatch ? text(addressMatch[1]) : '');

    seen.add(sourceId);
    cards.push({
      sourceId,
      url: `https://www.house.kg${link[1]}`,
      ...parseTitle(title),
      priceUsd: prices.usd,
      priceKgs: prices.kgs,
      address: address || null,
      city,
      byOwner: /Собственник/.test(card),
    });
  }

  return { cards, skipped };
}
