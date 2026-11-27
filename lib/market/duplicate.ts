/**
 * Сличение нашего объекта с объявлениями площадки.
 *
 * ЗАЧЕМ. Liberterra стоит на слове «Проверен». Слово это проверяемо
 * только одним способом: когда агент заводит объект, посмотреть, не висит
 * ли он уже на площадке — и если висит, показать, чем данные расходятся.
 * Другая цена, другая площадь, другой продавец — это и есть первичный
 * признак небрежного или чужого объявления.
 *
 * ГЛАВНОЕ ПРАВИЛО: НИКОГДА НЕ УТВЕРЖДАТЬ «ЭТО ТОТ ЖЕ ОБЪЕКТ». Доказать
 * это нечем. Два разных объявления на одной улице с одинаковой площадью
 * — обычное дело в новостройке, где сорок одинаковых квартир. Поэтому
 * наружу идёт «похоже на ваш объект» со списком совпавших признаков,
 * а решает человек. Ошибиться здесь дорого: утверждение «ваш объект уже
 * висит на house.kg» обвиняет агента в перепосте чужого.
 *
 * Модели здесь тоже нет: совпадение — это перечислимые признаки, а не
 * впечатление. Признаки видно, их можно оспорить, и они одинаковы для
 * всех объектов.
 */

/** Наш объект — в том виде, в каком его знает карточка кабинета. */
export type OurObject = {
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  /** Цена в основных единицах. */
  price: number;
  currency: string;
};

/** Объявление площадки — кандидат на совпадение. */
export type Candidate = {
  id: string;
  url: string;
  address: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  priceUsd: number | null;
  priceKgs: number | null;
  sellerKind: 'owner' | 'agency' | 'unknown';
  sellerName: string | null;
  bumpedAt: string | null;
};

/** Расхождение между нашими данными и объявлением. */
export type Difference = { what: string; ours: string; theirs: string };

export type Resemblance = {
  candidate: Candidate;
  /** Совпавшие признаки — показываются как есть. */
  signals: string[];
  differences: Difference[];
};

/**
 * Приведение адреса к словам.
 *
 * Та же мысль, что у search_text объектов: регистр и кыргызские буквы
 * сводятся, потому что «Чүй» и «чуй» — одна улица. Номера домов
 * вынимаются отдельно: они различают соседние дома на одной улице, то
 * есть несут больше всего смысла.
 */
/**
 * Слова, которые есть в каждом втором адресе и совпадением не являются.
 *
 * Список, а не порог по длине: «ул» и «мкр» надо выбросить, а «Чуй» —
 * оставить, хотя она короче «микрорайона» вчетверо.
 */
const NOISE = new Set([
  'ул', 'улица', 'мкр', 'микрораион', 'микрорайон', 'дом', 'кв', 'квартира',
  'пер', 'переулок', 'пр', 'проспект', 'бульвар', 'село', 'город', 'раион',
  'район', 'жилои', 'комплекс', 'жк', 'ном', 'этаж', 'корпус',
]);

export function addressWords(value: string | null | undefined): {
  words: Set<string>;
  houses: Set<string>;
} {
  const text = (value ?? '')
    .toLowerCase()
    .replace(/ү/g, 'у').replace(/ө/g, 'о').replace(/ң/g, 'н').replace(/ё/g, 'е');

  const words = new Set<string>();
  const houses = new Set<string>();

  // Микрорайон — это имя места, а не номер дома, и записывается он
  // числом: «12 мкр, 57/1». Без этого адрес распадался на одни цифры, у
  // него не оставалось ни одного признака улицы, и сличение не
  // срабатывало никогда — а в Бишкеке таких адресов половина.
  for (const m of text.matchAll(/(\d+)\s*(?:мкр|микрораион|микрорайон)|(?:мкр|микрораион|микрорайон)\s*(\d+)/g)) {
    words.add(`мкр-${m[1] ?? m[2]}`);
  }

  for (const piece of text.split(/[^a-zа-я0-9/]+/)) {
    if (!piece) continue;
    // Номер дома: цифры, возможно с корпусом через дробь или букву.
    if (/^\d+[а-я]?(\/\d+[а-я]?)*$/.test(piece)) {
      houses.add(piece);
      // Корпус отбрасывается отдельным значением: «Чуй 120» и «Чуй
      // 120/1» — один дом, и площадка с агентом пишут его по-разному.
      // Без этого совпадение по номеру не срабатывало ни разу там, где
      // оно важнее всего.
      const base = piece.split('/')[0];
      if (base !== piece) houses.add(base);
      continue;
    }
    // Служебные слова выбрасываются ПОИМЁННО, а не по длине. Сперва
    // стоял порог «от четырёх букв», и он выбрасывал «Чуй» — главную
    // улицу Бишкека: три буквы. Объект на Чуй переставал сличаться
    // вовсе, и это было бы незаметно.
    if (piece.length >= 3 && !NOISE.has(piece)) words.add(piece);
  }

  return { words, houses };
}

/** Общие слова и номера домов двух адресов. */
export function addressOverlap(a: string | null, b: string | null): {
  words: string[];
  houses: string[];
} {
  const one = addressWords(a);
  const two = addressWords(b);
  return {
    words: [...one.words].filter((w) => two.words.has(w)),
    houses: [...one.houses].filter((h) => two.houses.has(h)),
  };
}

/** Насколько два числа расходятся, в процентах от первого. */
function apart(ours: number, theirs: number): number {
  if (ours <= 0) return 0;
  return Math.round(((theirs - ours) / ours) * 100);
}

const SELLER_RU: Record<string, string> = {
  owner: 'собственник',
  agency: 'агентство',
  unknown: 'не определён',
};

/**
 * Сличение одного объявления с нашим объектом.
 *
 * Возвращает null, когда признаков слишком мало. Порог простой и
 * называемый словами: нужен либо совпавший номер дома вместе со словом
 * из адреса, либо совпавшее слово плюс очень близкая площадь. Одной
 * только похожей площади мало — в доме таких квартир десяток.
 */
export function resemble(
  ours: OurObject,
  candidate: Candidate,
  rate: number | null,
): Resemblance | null {
  const overlap = addressOverlap(ours.address + ' ' + (ours.zone ?? ''), candidate.address);
  const signals: string[] = [];

  const sameHouse = overlap.houses.length > 0;
  const sameStreet = overlap.words.length > 0;

  if (sameStreet) signals.push(`адрес: ${overlap.words.join(', ')}`);
  if (sameHouse) signals.push(`номер дома: ${overlap.houses.join(', ')}`);

  const areaGap = ours.area && candidate.area ? Math.abs(apart(ours.area, candidate.area)) : null;
  const areaClose = areaGap !== null && areaGap <= 2;
  if (areaClose) signals.push(`площадь совпадает: ${candidate.area} м²`);

  const sameRooms = ours.rooms !== null && candidate.rooms === ours.rooms;
  if (sameRooms) signals.push(`комнат столько же: ${candidate.rooms}`);

  const sameFloor = ours.floor !== null && candidate.floor === ours.floor;
  if (sameFloor) signals.push(`этаж тот же: ${candidate.floor}`);

  const enough = (sameHouse && sameStreet) || (sameStreet && areaClose);
  if (!enough) return null;

  // Расхождения. Считаются только там, где есть что с чем сравнить:
  // отсутствие поля у площадки — не расхождение, а отсутствие поля.
  const differences: Difference[] = [];

  const theirPrice = ours.currency === 'KGS'
    ? candidate.priceKgs ?? (candidate.priceUsd !== null && rate
      ? Math.round(candidate.priceUsd * rate) : null)
    : candidate.priceUsd ?? (candidate.priceKgs !== null && rate
      ? Math.round(candidate.priceKgs / rate) : null);

  if (theirPrice !== null) {
    const gap = apart(ours.price, theirPrice);
    if (gap !== 0) {
      differences.push({
        what: 'цена',
        ours: `${ours.price.toLocaleString('ru-RU')} ${ours.currency}`,
        theirs: `${theirPrice.toLocaleString('ru-RU')} ${ours.currency}`
          + ` (${gap > 0 ? '+' : ''}${gap}%)`,
      });
    }
  }

  if (ours.area !== null && candidate.area !== null && areaGap !== null && areaGap > 2) {
    differences.push({
      what: 'площадь',
      ours: `${ours.area} м²`,
      theirs: `${candidate.area} м²`,
    });
  }

  if (ours.rooms !== null && candidate.rooms !== null && candidate.rooms !== ours.rooms) {
    differences.push({
      what: 'комнат',
      ours: String(ours.rooms),
      theirs: String(candidate.rooms),
    });
  }

  if (ours.floor !== null && candidate.floor !== null && candidate.floor !== ours.floor) {
    differences.push({
      what: 'этаж',
      ours: String(ours.floor),
      theirs: String(candidate.floor),
    });
  }

  differences.push({
    what: 'подаёт',
    ours: 'агентство (мы)',
    theirs: candidate.sellerName
      ? `${SELLER_RU[candidate.sellerKind]} — ${candidate.sellerName}`
      : SELLER_RU[candidate.sellerKind],
  });

  return { candidate, signals, differences };
}

/** Сличение со всеми кандидатами: сперва те, у кого признаков больше. */
export function resembleAll(
  ours: OurObject,
  candidates: Candidate[],
  rate: number | null,
): Resemblance[] {
  return candidates
    .map((c) => resemble(ours, c, rate))
    .filter((r): r is Resemblance => r !== null)
    .sort((a, b) => b.signals.length - a.signals.length);
}
