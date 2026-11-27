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

const BY_CODE = new Map(SPACE_TYPES.map((t) => [t.code, t]));

export function isSpaceType(v: string | null | undefined): boolean {
  return typeof v === 'string' && BY_CODE.has(v);
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
