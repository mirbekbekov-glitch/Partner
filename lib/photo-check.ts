/**
 * Проверка панорамы при загрузке.
 *
 * Зачем. Тур собирается из того, что снял агент, и ни один алгоритм не
 * починит кадр, снятый с шага, в темноте или против окна. Узнать об этом
 * агент должен сразу, пока он ещё в квартире и может переснять, — а не
 * через неделю от покупателя.
 *
 * Это ПОДСКАЗКА, а не запрет. Загрузку ничего не останавливает: бывает
 * тёмная комната, которую иначе не снять, и бывает срочность, когда
 * лучше плохая панорама, чем никакой. Решает агент, а не проверка.
 *
 * Считается всё на уменьшенной копии: на 256 точках по ширине видно и
 * темноту, и размытость, а времени это занимает миллисекунды даже на
 * телефоне. Модуль чистый — ни сети, ни базы, ни DOM, — и потому
 * проверяется тестами как обычная функция.
 */

export type Issue = { kind: 'dark' | 'blurry' | 'narrow' | 'small'; text: string };

/** Яркость по Rec. 601: глаз видит зелёный куда лучше синего. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export type Gray = { data: Float32Array; w: number; h: number };

/** Серая копия для расчётов. */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    data[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return { data, w, h };
}

/** Средняя яркость, 0–255. */
export function meanLuma(g: Gray): number {
  let sum = 0;
  for (let i = 0; i < g.data.length; i++) sum += g.data[i];
  return g.data.length ? sum / g.data.length : 0;
}

/**
 * Резкость: разброс лапласиана.
 *
 * Лапласиан — это перепад яркости между точкой и её соседями. На резком
 * снимке перепады велики и разнородны, на размытом их почти нет. Мера
 * грубая и обманывается однотонной стеной во весь кадр, поэтому порог
 * взят низкий: лучше промолчать, чем сказать агенту, что его резкий
 * снимок размыт.
 */
export function sharpness(g: Gray): number {
  const { data, w, h } = g;
  if (w < 3 || h < 3) return Number.POSITIVE_INFINITY;

  let sum = 0;
  let sumSq = 0;
  let n = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i]
        - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  if (n === 0) return Number.POSITIVE_INFINITY;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Порог темноты: ниже этого комната на снимке уже не читается. */
const DARK = 60;

/** Порог размытости. Ниже — почти наверняка смазано или не в фокусе. */
const BLUR = 12;

/** Меньше этого по ширине — не панорама, а кадр. */
const SMALL = 1800;

/**
 * Что не так с панорамой.
 *
 * Пустой список — всё в порядке. Порядок проверок — от самого частого к
 * самому редкому: агент читает первую строку и уходит переснимать.
 */
export function checkPanorama(
  gray: Gray | null,
  width: number,
  height: number,
): Issue[] {
  const issues: Issue[] = [];

  // Пропорции: полный оборот даёт полосу вдвое длиннее высоты и больше.
  // Квадратный кадр — это обычный снимок, попавший сюда по ошибке.
  if (width > 0 && height > 0 && width / height < 2) {
    issues.push({
      kind: 'narrow',
      text: 'Похоже на обычный снимок, а не на панораму: снимите режимом «Панорама», полный оборот',
    });
  }

  if (width > 0 && width < SMALL) {
    issues.push({
      kind: 'small',
      text: 'Панорама мелкая: в туре она будет размытой. Снимите в полном качестве',
    });
  }

  if (gray) {
    if (meanLuma(gray) < DARK) {
      issues.push({
        kind: 'dark',
        text: 'Темно: включите свет и откройте шторы, снимать против окна не надо',
      });
    }
    if (sharpness(gray) < BLUR) {
      issues.push({
        kind: 'blurry',
        text: 'Смазано: поворачивайтесь медленнее и не сходите с места',
      });
    }
  }

  return issues;
}
