/**
 * Чтение публичных объявлений house.kg: аналоги для оценки рынка.
 *
 * ЗАЧЕМ. Оценка «по рынку» без рынка — выдумка. Своя база мала: по связке
 * «район + комнаты + площадь» в ней найдётся два объекта, а на двух
 * средней цены не бывает. Аналоги берутся там, где их тысячи.
 *
 * ОТКУДА ИМЕННО. Со страниц ПОИСКА — тех самых, что открывает человек в
 * браузере. Внутренний /api/ площадки закрыт в её robots.txt, и мы туда
 * не ходим: запрет площадки — её право, а не препятствие, которое надо
 * обойти. Одна страница поиска отдаёт сорок карточек, и в каждой уже есть
 * всё, что нужно оценке. Ходить за каждым объявлением отдельно значило бы
 * сорокакратный трафик ради тех же чисел.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Не ходит в базу и не знает о ней. Поэтому
 * разбор проверяется на сохранённом снимке настоящей страницы
 * (tests/fixtures/house-kg-search.html) без сети и без базы.
 */

/** Сделка, как она называется во всей базе. */
export type DealType = 'rent' | 'sale';

/** Тип объекта, как он называется во всей базе. */
export type Kind = 'flat' | 'room' | 'house' | 'land';

/**
 * Разделы площадки. ТОЛЬКО ПРОВЕРЕННЫЕ ЖИВЫМИ ЗАПРОСАМИ.
 *
 * Каждый адрес здесь открывался и отдавал список с ожидаемым заголовком
 * («Аренда комнат в Бишкеке» и так далее). Угаданных адресов тут нет
 * сознательно: коммерция и гаражи по напрашивающимся именам отвечают 404,
 * и вписать их «на всякий случай» значило бы завести раздел, который
 * молча не работает.
 *
 * Появится верный адрес — строка добавляется сюда, и больше никуда.
 */
export const SECTIONS: ReadonlyArray<{ deal: DealType; kind: Kind; path: string }> = [
  { deal: 'sale', kind: 'flat', path: 'kupit-kvartiru' },
  { deal: 'rent', kind: 'flat', path: 'snyat-kvartiru' },
  { deal: 'sale', kind: 'room', path: 'kupit-komnatu' },
  { deal: 'rent', kind: 'room', path: 'snyat-komnatu' },
  { deal: 'sale', kind: 'house', path: 'kupit-dom' },
  { deal: 'rent', kind: 'house', path: 'snyat-dom' },
  { deal: 'sale', kind: 'land', path: 'kupit-uchastok' },
];

/** Города площадки: её собственный код. Проверен по заголовку выдачи. */
export const TOWNS: Readonly<Record<string, number>> = { 'Бишкек': 2 };

/** Одна карточка со страницы поиска. */
export type MarketCard = {
  /** Идентификатор объявления у площадки: часть адреса после /details/. */
  sourceId: string;
  url: string;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floorsTotal: number | null;
  /** Цена целыми долларами. Аренда часто идёт только в сомах. */
  priceUsd: number | null;
  /** Цена целыми сомами. Продажа иногда идёт только в долларах. */
  priceKgs: number | null;
  /**
   * За какой срок цена. У продажи — null, у аренды обязателен.
   *
   * Посуточная аренда — ДРУГОЙ РЫНОК: 2 200 сом в сутки и 63 000 сом в
   * месяц стоят в одной выдаче рядом. Смешав их в одной медиане, мы
   * получим число, которого на рынке нет.
   */
  period: 'month' | 'day' | null;
  address: string | null;
  /** Город из первой части адреса: «Бишкек, Медерова 44/2» → «Бишкек». */
  city: string | null;
  /** Кто продаёт — по бейджу И подписи сразу, см. sellerOf(). */
  sellerKind: 'owner' | 'agency' | 'unknown';
  sellerName: string | null;
  views: number | null;
  favorites: number | null;
  /** Площадка пометила объявление поднятым. */
  bumped: boolean;
  /** Что написано на карточке словами: «4 часа назад». */
  bumpedText: string | null;
  /** Собственная метка площадки: «Выше рынка на 74.27%». Чужая оценка. */
  marketNote: string | null;
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
 * ипотеке, который стоит в той же карточке («167 514 сом в мес»).
 * Перепутать их значит оценить квартиру в 167 тысяч вместо 23 миллионов,
 * и ошибка эта тихая: число выглядит правдоподобно.
 *
 * Курс держится около 87. Вилка 60–130 переживёт любое его движение и
 * остаётся непроходимой для постороннего числа: у платежа по ипотеке
 * отношение к долларовой цене выходит меньше единицы.
 */
const RATE_MIN = 60;
const RATE_MAX = 130;

/**
 * Запись денежной суммы: «25 935 000» или «514».
 *
 * Группы по три цифры заданы ЯВНО, и это не придирка к форматированию.
 * Раньше число бралось как «любые цифры и пробелы подряд», и в карточке
 * с адресом «Токомбаева 21/6» к цене приклеивалась шестёрка из номера
 * дома: вместо 25 935 000 получалось 625 935 000, отношение к доллару
 * выходило за границы курса, и ВСЯ КАРТОЧКА МОЛЧА ОТБРАСЫВАЛАСЬ. Нашлось
 * это только прогоном разбора по настоящему снимку страницы.
 */
const MONEY = '(\\d{1,3}(?:[\\s\\u00a0\\u202f]\\d{3})+|\\d+)';

/** Границы правдоподобной цены в долларах: отсев опечаток и «1 $». */
const PRICE_MIN_USD = 50;
const PRICE_MAX_USD = 20_000_000;

function countSkip(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** Адрес страницы поиска. Страница первая — без параметра, как у них. */
export function searchUrl(path: string, town: number, page = 1): string {
  const base = `https://www.house.kg/${path}?town=${town}`;
  return page > 1 ? `${base}&page=${page}` : base;
}

/** Текст без разметки: теги в пробелы, сущности — на место. */
export function text(html: string): string {
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

/** Число из записи вида «23 652 000» — с любыми пробелами внутри. */
function amount(raw: string): number | null {
  const digits = raw.replace(/[\s  ]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Характеристики объявления: комнаты, площадь, этажи.
 *
 * Площадка рисует одно объявление ДВУМЯ карточками — полной и сжатой, —
 * и поля в них записаны по-разному:
 *
 *   полная:  «2-комн. кв., 92 м², 5 этаж из 10»  — одной строкой-заголовком
 *   сжатая:  «Квартира | 2 комн. | 92 м² | 5/10 этаж» — отдельными полями
 *
 * Читаются обе. Пока читалась только первая, вся аренда теряла заголовок
 * и отбрасывалась: у сжатой карточки строки-заголовка нет вовсе.
 *
 * Участок измеряется сотками, и они переводятся в метры (сотка — ровно
 * 100 м²). Это пересчёт, а не выдумка: без него площадь участка в 8 соток
 * встала бы в один ряд с квартирой в 8 м².
 */
export function specsOf(cardHtml: string): {
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floorsTotal: number | null;
} {
  const t = text(cardHtml);

  const rooms = t.match(/(\d+)\s*-?\s*комн/i);
  const area = t.match(/([\d.,]+)\s*м²/i);
  const sotka = t.match(/([\d.,]+)\s*сот/i);
  // «5 этаж из 10» — полная карточка, «5/10 этаж» — сжатая.
  const floorFull = t.match(/(\d+)\s*этаж\s*из\s*(\d+)/i);
  const floorShort = t.match(/(\d+)\s*\/\s*(\d+)\s*этаж/i);
  const floorOnly = t.match(/(\d+)\s*этаж/i);

  const num = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const v = Number(raw.replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  const metres = num(area?.[1]);
  const sotki = num(sotka?.[1]);

  const floors = floorFull ?? floorShort;

  return {
    rooms: rooms ? Number(rooms[1]) : null,
    area: metres ?? (sotki === null ? null : sotki * 100),
    floor: floors ? Number(floors[1]) : floorOnly ? Number(floorOnly[1]) : null,
    floorsTotal: floors ? Number(floors[2]) : null,
  };
}

/**
 * Цены карточки: сколько, в чём и за какой срок.
 *
 * ПРОДАЖА. В карточке три числа: цена в сомах, цена в долларах и ПЛАТЁЖ
 * ПО ИПОТЕКЕ («167 514 сом в мес»). Платёж отсекается дважды. Во-первых,
 * у него есть срок, а у цены продажи срока не бывает — числа со сроком
 * при продаже не рассматриваются вовсе. Во-вторых, пара валют обязана
 * сойтись по курсу: у платежа отношение к долларовой цене меньше единицы.
 * Двух проверок, а не одной, потому что цена — то место, где тихая ошибка
 * стоит дороже всего: 167 тысяч вместо 23 миллионов выглядят правдоподобно.
 *
 * АРЕНДА. Здесь всё наоборот: срок ОБЯЗАТЕЛЕН, а вторая валюта почти
 * всегда отсутствует — площадка пишет «63 000 ⃀ / мес» и больше ничего.
 * Требовать пару значило бы выбросить аренду целиком, что и происходило,
 * пока разбор не прогнали по живой странице.
 *
 * Объявление аренды без срока отбрасывается. Назначить ему месяц «по
 * умолчанию» нельзя: в той же выдаче лежит посуточная, и ошибка сделала
 * бы комнату за 2 200 в сутки комнатой за 2 200 в месяц.
 */
export function parsePrices(
  cardHtml: string,
  deal: DealType,
): { usd: number | null; kgs: number | null; period: 'month' | 'day' | null } | null {
  const flat = text(cardHtml);

  type Token = { value: number; currency: 'usd' | 'kgs'; period: 'month' | 'day' | null };
  const tokens: Token[] = [];

  // Числа ищутся ПО ТЕКСТОВЫМ УЗЛАМ разметки, а не по всей карточке
  // подряд. Причина конкретная: рядом с ценой стоит счётчик фотографий,
  // и в сплошном тексте «… 30 306 250 ⃀» число «30 306 250» выглядит
  // правильно сгруппированным — ровно так к цене и приклеивалась
  // соседняя цифра. В разметке же счётчик лежит в своём узле, а цена в
  // своём, и приклеиваться нечему.
  //
  // Комментарии разметки убираются заранее: площадка ставит «<!-- -->»
  // прямо внутри цены, между суммой и сроком.
  const clean = cardHtml.replace(/<!--[\s\S]*?-->/g, '');
  const re = new RegExp(
    MONEY + '\\s*(⃀|сом|\\$)\\s*(?:(?:/|в)\\s*(мес[а-я]*|сут[а-я]*))?',
    'gi',
  );

  for (const node of clean.matchAll(/>([^<]{1,80})</g)) {
    const piece = text(node[1]);
    if (!/⃀|сом|\$/.test(piece)) continue;

    for (const m of piece.matchAll(re)) {
      const value = amount(m[1]);
      if (value === null) continue;

      const currency = m[2] === '$' ? 'usd' : 'kgs';
      const periodWord = (m[3] ?? '').toLowerCase();
      const period = periodWord.startsWith('сут') ? 'day'
        : periodWord.startsWith('мес') ? 'month'
        : null;

      tokens.push({ value, currency, period });
    }
  }

  if (deal === 'sale') {
    // Числа со сроком при продаже — это ипотека, а не цена.
    const usd = tokens.filter((t) => t.period === null && t.currency === 'usd');
    const kgs = tokens.filter((t) => t.period === null && t.currency === 'kgs');

    for (const u of usd) {
      if (u.value < PRICE_MIN_USD || u.value > PRICE_MAX_USD) continue;
      for (const k of kgs) {
        const rate = k.value / u.value;
        if (rate >= RATE_MIN && rate <= RATE_MAX) {
          return { usd: u.value, kgs: k.value, period: null };
        }
      }
    }

    // Пара не сошлась — цены нет. Одинокое число при продаже не берём:
    // ровно так и выглядит платёж по ипотеке, если срок не написан.
    return null;
  }

  const withPeriod = tokens.filter((t) => t.period !== null);

  // Часть объявлений аренды срока не пишет вовсе, но называет ОБЕ валюты:
  // «306 250 ⃀ · 3 496 $». Выбрасывать их — терять примерно каждое
  // пятнадцатое, и как раз дорогие дома.
  //
  // Такие считаются месячными, и это ДОПУЩЕНИЕ, проверенное на живых
  // страницах: из 74 объявлений аренды 12 были посуточными, и ВСЕ
  // двенадцать помечены «/ сутки»; из пяти объявлений без срока слова
  // «посуточно» или «сутки» не встретилось ни в одном.
  //
  // Поэтому допущение ограничено дважды: нужна пара валют по курсу (как
  // у продажи — она же отсекает платёж по ипотеке), и в карточке не
  // должно быть ни слова о сутках. Сказано про сутки, но срок не
  // распознан — объявление отбрасывается: лучше потерять одно, чем
  // поставить посуточную цену в месячную медиану.
  if (withPeriod.length === 0) {
    if (/посуточн|сутк/i.test(flat)) return null;

    const usdAny = tokens.filter((t) => t.currency === 'usd');
    const kgsAny = tokens.filter((t) => t.currency === 'kgs');
    for (const u of usdAny) {
      if (u.value < PRICE_MIN_USD || u.value > PRICE_MAX_USD) continue;
      for (const k of kgsAny) {
        const rate = k.value / u.value;
        if (rate >= RATE_MIN && rate <= RATE_MAX) {
          return { usd: u.value, kgs: k.value, period: 'month' };
        }
      }
    }
    return null;
  }

  const period = withPeriod[0].period;
  const sameTerm = withPeriod.filter((t) => t.period === period);
  const usd = sameTerm.find((t) => t.currency === 'usd') ?? null;
  const kgs = sameTerm.find((t) => t.currency === 'kgs') ?? null;

  if (usd === null && kgs === null) return null;
  return { usd: usd?.value ?? null, kgs: kgs?.value ?? null, period };
}

/**
 * Кто продаёт.
 *
 * БЕЙДЖ «Собственник» САМ ПО СЕБЕ НИЧЕГО НЕ ДОКАЗЫВАЕТ. Проверено на
 * живой странице 27 ноября 2026: в одной карточке стоят одновременно
 * бейдж «Собственник» и подпись «От Avangard style», то есть продаёт
 * агентство. Если поверить бейджу, список «объектов от собственника»
 * наполнится агентствами — а это ровно те, кому звонить незачем.
 *
 * Поэтому 'owner' ставится, только когда бейдж есть, а подписи «От …»
 * нет. Есть подпись — это 'agency' с именем. Нет ни того ни другого —
 * 'unknown', и это честный ответ, а не заглушка.
 */
export function sellerOf(cardHtml: string): {
  kind: 'owner' | 'agency' | 'unknown';
  name: string | null;
} {
  const signature = cardHtml.match(/>\s*От\s+([^<]{2,60}?)\s*</);
  const badge = /Собственник/.test(cardHtml);

  if (signature) return { kind: 'agency', name: text(signature[1]) };
  if (badge) return { kind: 'owner', name: null };
  return { kind: 'unknown', name: null };
}

/**
 * «4 часа назад» → момент времени.
 *
 * Площадка пишет возраст словами и от «сейчас». Храним и слово, и число:
 * когда разбор ошибётся, по слову будет видно, на чём именно.
 *
 * Неизвестная запись возвращает null, а не «сейчас»: выдуманная свежесть
 * подняла бы объявлению оценку актуальности, то есть соврала бы в пользу
 * мёртвого объявления.
 */
export function bumpedAt(label: string, nowMs: number): string | null {
  const t = label.toLowerCase().trim();

  if (/только что|сейчас/.test(t)) return new Date(nowMs).toISOString();

  // «Позавчера» проверяется ДО «вчера» и отдельно от него: подстрока
  // «вчера» сидит внутри слова «позавчера», и порядок здесь — не
  // стилистика. Наоборот было бы на двое суток свежее, чем на самом деле.
  if (/позавчера/.test(t)) return new Date(nowMs - 48 * 3600_000).toISOString();
  if (/вчера/.test(t)) return new Date(nowMs - 24 * 3600_000).toISOString();
  if (/сегодня/.test(t)) return new Date(nowMs).toISOString();

  // Число необязательно: площадка пишет и «3 дня назад», и «месяц назад».
  // Единица без числа означает одну — так это и читается по-русски.
  const m = t.match(/(?:(\d+)\s*)?(минут|час|сутк|дн|день|дня|дней|недел|месяц|год)/);
  if (!m) return null;

  const n = m[1] ? Number(m[1]) : 1;
  const unit = m[2];

  const hours = unit.startsWith('минут') ? n / 60
    : unit.startsWith('час') ? n
    : unit.startsWith('недел') ? n * 24 * 7
    : unit.startsWith('месяц') ? n * 24 * 30
    : unit.startsWith('год') ? n * 24 * 365
    : n * 24;

  return new Date(nowMs - hours * 3600_000).toISOString();
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
 * Площадка рисует КАЖДОЕ объявление двумя элементами <article>: полной
 * карточкой и сжатой. Сорок элементов на странице — это двадцать
 * объявлений. Поэтому карточки сперва группируются по идентификатору
 * объявления, и объявление собирается из обеих: цену берём оттуда, где
 * она прочиталась, характеристики — тоже.
 *
 * Пока бралась первая попавшаяся карточка, вторая попадала в «отброшено»
 * как ошибка разбора, хотя это просто другая вёрстка того же самого. А в
 * аренде терялось и объявление целиком.
 *
 * Объявление без цены ОТБРАСЫВАЕТСЯ с причиной, а не попадает в выдачу с
 * нулём: ноль в выборке аналогов сдвинул бы медиану вниз молча.
 */
export function parseSearchPage(html: string, deal: DealType): ParseResult {
  const groups = new Map<string, { path: string; parts: string[] }>();

  for (const match of html.matchAll(/<article\b[\s\S]*?<\/article>/g)) {
    const card = match[0];
    const link = card.match(/href="(\/details\/([^"?#]+))"/);
    if (!link) continue;

    const group = groups.get(link[2]);
    if (group) group.parts.push(card);
    else groups.set(link[2], { path: link[1], parts: [card] });
  }

  const cards: MarketCard[] = [];
  const skipped: Record<string, number> = {};

  for (const [sourceId, group] of groups) {
    // Склейка всех карточек объявления: сигналы и адрес ищем во всех,
    // потому что в полной и сжатой они стоят в разных местах.
    const whole = group.parts.join('\n');

    let prices: ReturnType<typeof parsePrices> = null;
    for (const part of group.parts) {
      prices = parsePrices(part, deal);
      if (prices) break;
    }
    if (!prices) {
      countSkip(skipped, deal === 'rent' ? 'цена или срок аренды не распознаны' : 'цена не распознана');
      continue;
    }

    const addressMatch = whole.match(/aria-label="([^"]+)"/);
    const { city, address } = splitAddress(addressMatch ? text(addressMatch[1]) : '');
    const flat = text(whole);
    const seller = sellerOf(whole);

    const views = flat.match(/просмотров\s*(\d+)/i);
    const favorites = flat.match(/в избранном\s*(\d+)/i);
    const ago = flat.match(/((?:\d+\s*)?(?:минут|час|дн|день|дня|дней|недел|месяц)[а-я]*\s*назад|позавчера|сегодня|вчера)/i);
    const note = flat.match(/(Выше рынка на [\d.,]+\s*%|Ниже рынка на [\d.,]+\s*%|Справедливая цена)/i);

    cards.push({
      sourceId,
      url: `https://www.house.kg${group.path}`,
      ...specsOf(whole),
      priceUsd: prices.usd,
      priceKgs: prices.kgs,
      period: prices.period,
      address: address || null,
      city,
      sellerKind: seller.kind,
      sellerName: seller.name,
      views: views ? Number(views[1]) : null,
      favorites: favorites ? Number(favorites[1]) : null,
      bumped: /aria-label="Поднято"/.test(whole),
      bumpedText: ago ? ago[1] : null,
      marketNote: note ? note[1] : null,
    });
  }

  return { cards, skipped };
}

/**
 * Загрузка одной страницы поиска.
 *
 * Отдельной функцией, чтобы разбор оставался проверяемым без сети. Ошибка
 * сети и ответ не-200 возвращают null: обход пропустит страницу и пойдёт
 * дальше. Чужая площадка не обязана быть доступной, и её недоступность —
 * не наша авария.
 */
export async function fetchSearchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        // Представляемся браузером: страница рассчитана на него, и
        // отдавать её роботу площадка не обязана.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        'accept-language': 'ru,ru-RU;q=0.9',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
