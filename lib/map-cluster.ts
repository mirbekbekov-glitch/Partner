/**
 * Сгущения булавок и короткая цена — без карты и без браузера.
 *
 * Отдельным модулем, потому что это вся арифметика карты, и проверять
 * её надо без Leaflet: внутри компонента она была бы непокрываема
 * ничем, кроме настоящего браузера.
 *
 * Готовый markercluster не взят намеренно: это ещё сорок килобайт и
 * своя вёрстка булавок, а нужна от него одна вещь — сетка по экрану.
 */

export type Placed = { id: string; x: number; y: number };

export type Cell<T> = {
  /** Клетка сетки: по ней собираются точки. */
  key: string;
  items: T[];
};

/**
 * Разложить точки по клеткам экрана.
 *
 * По ЭКРАНУ, а не по градусам. Клетка в градусах на севере и на юге
 * разного размера на вид, и сгущения получались бы тем крупнее, чем
 * дальше от экватора. Человек же судит по картинке.
 *
 * Порядок клеток повторяет порядок точек: иначе булавки перескакивали
 * бы с места на место при каждой перерисовке, хотя карта не двигалась.
 */
export function cluster<T>(
  items: T[],
  at: (item: T) => { x: number; y: number },
  cellSize: number,
): Cell<T>[] {
  const size = cellSize > 0 ? cellSize : 1;
  const cells = new Map<string, Cell<T>>();

  for (const item of items) {
    const { x, y } = at(item);
    const key = `${Math.floor(x / size)}:${Math.floor(y / size)}`;
    const cell = cells.get(key);
    if (cell) cell.items.push(item);
    else cells.set(key, { key, items: [item] });
  }

  return [...cells.values()];
}

/** Середина группы точек: центр кружка стоит среди домов, а не в углу клетки. */
export function middle(
  points: Array<{ latitude: number; longitude: number }>,
): [number, number] {
  const n = points.length || 1;
  return [
    points.reduce((s, p) => s + p.latitude, 0) / n,
    points.reduce((s, p) => s + p.longitude, 0) / n,
  ];
}

export type PriceUnits = { mln: string; thd: string; som: string };

/**
 * Короткая цена для булавки: «7.7 млн», «$84 тыс.».
 *
 * Коротко, потому что булавка — ярлык шириной в палец, и «7 345 800
 * сом» в неё не влезает: на карте нужно отличить дешёвое от дорогого с
 * одного взгляда, а не прочитать число до рубля.
 *
 * Сокращения приходят словарём: вписать «млн» прямо здесь в
 * четырёхъязычной витрине — то же самое, что подписать склад
 * «warehouse» на русской странице.
 *
 * Округление ВВЕРХ не делаем и вниз тоже: «84 тыс.» рядом с 84 500 —
 * это подпись, а не цена, и точная стоит в карточке. Но знак валюты
 * обязателен: «84 тыс.» без него читается как сомы.
 */
export function shortPrice(
  value: number, currency: string, units: PriceUnits,
): string {
  const sign = currency === 'KGS' ? '' : '$';
  const tail = currency === 'KGS' ? units.som : '';
  if (value >= 1_000_000) {
    return `${sign}${(value / 1_000_000).toFixed(1)}${units.mln}${tail}`;
  }
  if (value >= 1_000) {
    return `${sign}${Math.round(value / 1_000)}${units.thd}${tail}`;
  }
  return `${sign}${Math.round(value)}${tail}`;
}
