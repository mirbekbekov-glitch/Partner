/**
 * Что именно ищет человек: словарь для формы заявки.
 *
 * Без 'server-only': список нужен и форме в браузере, и слою доступа для
 * проверки, и обоим он должен быть одним.
 *
 * Два уровня, потому что их два в жизни. Человек сначала понимает, что
 * ему нужно — жильё, коммерция или место за столом, — и только потом
 * уточняет. Плоский список из тринадцати пунктов заставляет читать все
 * тринадцать, а сгруппированный — три заголовка.
 *
 * Зачем вообще: прежний список был из семи значений, и «коммерческая»
 * означала разом офис, кабинет, здание, склад и торговую точку. Человек,
 * ищущий кабинет на двоих, не находил себя и писал в «пожелания» — а
 * агент потом звонил выяснять то, что можно было спросить формой.
 */

export type SpaceGroup = 'housing' | 'commercial' | 'workplace';

export type SpaceType = {
  code: string;
  group: SpaceGroup;
  /**
   * Огрублённое значение для housing_type.
   *
   * На него опираются порог рынка, подбор и превращение заявки в
   * потребность: там словарь объектов, и он пока крупнее. Пересобирать
   * словарь объектов — отдельная работа, она требует перестройки таблицы
   * (CHECK в SQLite не меняется), и делать её заодно нельзя.
   */
  coarse: string;
};

export const SPACE_TYPES: SpaceType[] = [
  { code: 'flat',       group: 'housing',    coarse: 'flat' },
  { code: 'room',       group: 'housing',    coarse: 'room' },
  { code: 'house',      group: 'housing',    coarse: 'house' },
  { code: 'townhouse',  group: 'housing',    coarse: 'townhouse' },
  { code: 'land',       group: 'housing',    coarse: 'land' },
  { code: 'garage',     group: 'housing',    coarse: 'garage' },

  { code: 'office',     group: 'commercial', coarse: 'commercial' },
  { code: 'cabinet',    group: 'commercial', coarse: 'commercial' },
  { code: 'building',   group: 'commercial', coarse: 'commercial' },
  { code: 'retail',     group: 'commercial', coarse: 'commercial' },
  { code: 'warehouse',  group: 'commercial', coarse: 'commercial' },
  { code: 'production', group: 'commercial', coarse: 'commercial' },

  { code: 'desk',       group: 'workplace',  coarse: 'commercial' },
];

/**
 * Что можно ЗАВЕСТИ как объект. Шире, чем список заявки, и вот почему.
 *
 * Список заявки (SPACE_TYPES выше) ограничен CHECK'ом колонки space_type,
 * а CHECK в SQLite меняется только перестройкой таблицы. Расширять его
 * заодно нельзя — это отдельная работа.
 *
 * Объекту же нужнее. Во-первых, кабинет и рабочее место в коворкинге —
 * настоящий товар площадки, и опубликовать их надо, а не подписывать
 * офисом. Во-вторых, справочник m-house, куда уходит выгрузка, различает
 * общепит, отель, автосервис, салон красоты, медцентр, сельхозугодье и
 * торговый контейнер. Будь наш словарь беднее его, выгрузка потеряла бы
 * точность: ресторанное помещение уехало бы «офисом».
 *
 * Поэтому здесь объединение: наши коды — главные, значение площадки
 * ВЫВОДИТСЯ из них (mhouseCommercial в lib/mhouse.ts), а не наоборот.
 *
 * «Сельхозугодье» огрубляется в commercial, а не в land, потому что так
 * его считает площадка: в её справочнике это вид коммерции. Расхождение
 * с ней стоило бы дороже, чем неидеальное огрубление.
 */
export const OBJECT_TYPES: SpaceType[] = [
  ...SPACE_TYPES,

  { code: 'catering',    group: 'commercial', coarse: 'commercial' },
  { code: 'hotel',       group: 'commercial', coarse: 'commercial' },
  { code: 'auto',        group: 'commercial', coarse: 'commercial' },
  { code: 'beauty',      group: 'commercial', coarse: 'commercial' },
  { code: 'medical',     group: 'commercial', coarse: 'commercial' },
  { code: 'agriculture', group: 'commercial', coarse: 'commercial' },
  { code: 'container',   group: 'commercial', coarse: 'commercial' },
];

const BY_CODE = new Map(OBJECT_TYPES.map((t) => [t.code, t]));

/**
 * Годится ли код для ЗАЯВКИ.
 *
 * Именно для заявки, а не вообще: в её колонке стоит CHECK с коротким
 * списком, и код из объектного расширения база не примет. Проверять по
 * общей карте значило бы пропустить «отель» в заявку и получить отказ
 * базы вместо внятной ошибки.
 */
export function isSpaceType(v: string | null | undefined): boolean {
  return typeof v === 'string' && SPACE_TYPES.some((t) => t.code === v);
}

/**
 * Огрублённое значение для housing_type.
 *
 * Неизвестный код даёт пусто, а не выдуманное значение: заявка без типа
 * лучше заявки с подменённым типом — агент хотя бы спросит.
 */
export function coarseOf(code: string | null | undefined): string | null {
  return (code && BY_CODE.get(code)?.coarse) ?? null;
}

/**
 * Пресеты срока аренды, в днях.
 *
 * Пресет — подпись к числам, а не второй источник правды: в базе лежат
 * только дни. «От года» без верхней границы — это и есть долгий срок, и
 * придумывать ему потолок незачем.
 */
export const TERM_PRESETS: Array<{ code: string; min: number; max: number | null }> = [
  { code: 'daily',   min: 1,   max: 30 },
  { code: 'months3', min: 30,  max: 90 },
  { code: 'months6', min: 90,  max: 180 },
  { code: 'year',    min: 365, max: null },
];

/**
 * Граница между «посуточно» и «снять»: месяц.
 *
 * Одно число на всю систему, потому что иначе их стало бы три — своё в
 * отборе, своё в подписи, своё в выгрузке, — и в первый же месяц они
 * разошлись бы. Сдаётся посуточно тот объект, чей МИНИМАЛЬНЫЙ срок
 * меньше месяца; сдаётся надолго тот, чей МАКСИМАЛЬНЫЙ месяц
 * превышает. Один и тот же объект бывает и тем и другим — квартиру
 * сдают и на ночь, и на год, — и прятать его из одной выдачи ради
 * красоты разделения было бы враньём.
 */
export const MONTH_DAYS = 30;

export function isDailyTerm(min: number | null): boolean {
  return min !== null && min < MONTH_DAYS;
}

export function isLongTerm(max: number | null): boolean {
  return max === null || max > MONTH_DAYS;
}

/**
 * Срок в днях: приведение к допустимому виду.
 *
 * Один код на заявки и на объекты — иначе правила разошлись бы, и
 * заявка «от 180 до 30» чинилась бы, а объект с теми же числами нет.
 *
 * Перепутанные местами границы меняются местами молча: это обычная
 * опечатка, а не повод терять заявку или объявление. Десять лет —
 * потолок: больше похоже на мусор из формы, чем на намерение.
 */
export function termRange(
  applies: boolean,
  min: number | null | undefined,
  max: number | null | undefined,
): [number | null, number | null] {
  const day = (v: number | null | undefined) =>
    applies && v && v > 0 && v <= 3650 ? Math.trunc(v) : null;
  const lo = day(min);
  const hi = day(max);
  return lo && hi && lo > hi ? [hi, lo] : [lo, hi];
}
