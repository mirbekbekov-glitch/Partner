/**
 * Поправить свет на снимке.
 *
 * Две вещи, которые портят почти каждый кадр с телефона в квартире:
 * тёмный и плоский свет (камера мерит по окну) и цветной налёт от ламп
 * (жёлтый от лампы накаливания, зелёный от энергосберегающей).
 *
 * Это НЕ изменение квартиры. Тёмный кадр и тот же кадр со светом
 * показывают одну и ту же комнату, те же стены и ту же мебель. Поэтому
 * поправка света не требует пометки в объявлении, в отличие от стирания
 * предметов.
 *
 * Считается всё честной арифметикой, без модели: гистограмма и средние
 * по каналам. Модель здесь была бы и дороже, и непредсказуемее — она
 * «улучшала» бы кадр по своему вкусу, подрисовывая то, чего не было.
 *
 * Модуль чистый: ни сети, ни базы, ни DOM. Поэтому он проверяется
 * тестами как обычная арифметика.
 */

/** Насколько ярких и тёмных точек не жалко: хвосты гистограммы. */
const CLIP = 0.005;

/** Дальше этого тянуть нельзя: шум в тенях вылезет раньше, чем света. */
const MAX_STRETCH = 2.2;

/** Яркость по Rec. 601. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export type Levels = { low: number; high: number };

/**
 * Границы растяжки: где у снимка настоящие тени и настоящие света.
 *
 * Берутся не минимум и максимум, а процентили: одна пересвеченная
 * лампочка или одна чёрная щель иначе определяли бы весь снимок.
 */
export function levelsOf(gray: Float32Array): Levels {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray[i])))]++;

  const total = gray.length;
  const drop = Math.floor(total * CLIP);

  let low = 0;
  let seen = 0;
  while (low < 255 && seen + hist[low] <= drop) { seen += hist[low]; low++; }

  let high = 255;
  seen = 0;
  while (high > 0 && seen + hist[high] <= drop) { seen += hist[high]; high--; }

  return { low, high: Math.max(high, low + 1) };
}

/** Поправки баланса белого по «серому миру»: средние каналов сводятся. */
export function greyWorld(rgba: Uint8ClampedArray): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
  r /= n; g /= n; b /= n;

  const mean = (r + g + b) / 3;
  if (r <= 0 || g <= 0 || b <= 0) return [1, 1, 1];

  // Поправка приглушена наполовину: «серый мир» ошибается на снимках, где
  // большое цветное пятно — ковёр во весь пол, синяя стена, — и полная
  // поправка перекрасила бы комнату.
  const soft = (k: number) => 1 + (k - 1) * 0.5;
  return [soft(mean / r), soft(mean / g), soft(mean / b)];
}

/**
 * Какую среднюю яркость считаем нормальной для комнаты.
 *
 * 110 из 255 — чуть ниже середины: интерьер со светлыми стенами и
 * тёмной мебелью на этой отметке выглядит как при дневном свете, а не
 * как пересвеченный каталог мебели.
 */
const TARGET = 110;

/** Ниже этого разброса растягивать нечего: кадр ровный, а не плоский. */
const MIN_SPAN = 20;

/**
 * Поправить свет на месте.
 *
 * Два разных действия, и путать их нельзя. Растяжка уровней чинит
 * ПЛОСКИЙ кадр — тот, где всё серое, от штор до пола. Гамма чинит
 * ТЁМНЫЙ — тот, где перепады есть, но всё утоплено в тень.
 *
 * Растяжка применяется только когда есть что растягивать. Без этой
 * проверки однотонный кадр — стена в упор, снимок в сумерках — получал
 * размах в одну единицу, и вычитание нижней границы делало его чёрным.
 * Поймано тестом, а не на живом объявлении.
 *
 * Возвращает true, если что-то изменилось: на хорошем кадре поправка не
 * нужна, и говорить агенту «обработано» там, где ничего не сделано, —
 * вранье в мелочи, из которого вырастает недоверие ко всему остальному.
 */
export function fixLight(rgba: Uint8ClampedArray): boolean {
  const n = rgba.length / 4;
  if (n === 0) return false;

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }

  const { low, high } = levelsOf(gray);
  const span = high - low;
  const stretch = span >= MIN_SPAN ? Math.min(255 / span, MAX_STRETCH) : 1;
  const shift = span >= MIN_SPAN ? low : 0;

  const [kr, kg, kb] = greyWorld(rgba);

  // Средняя ПОСЛЕ растяжки: гамма досветляет то, что растяжка не
  // вытянула, и не трогает кадр, который она уже сделала светлым.
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.max(0, Math.min(255, (gray[i] - shift) * stretch));
  }
  const mean = sum / n;

  const gamma = mean > 4 && mean < TARGET
    ? Math.max(0.5, Math.log(TARGET / 255) / Math.log(mean / 255))
    : 1;

  const touches = Math.abs(stretch - 1) > 0.03
    || Math.abs(gamma - 1) > 0.03
    || Math.abs(kr - 1) > 0.02 || Math.abs(kg - 1) > 0.02 || Math.abs(kb - 1) > 0.02;
  if (!touches) return false;

  const map = (v: number, k: number) => {
    const out = (v * k - shift) * stretch;
    const clamped = out < 0 ? 0 : out > 255 ? 255 : out;
    return gamma === 1 ? clamped : 255 * ((clamped / 255) ** gamma);
  };

  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = map(rgba[i], kr);
    rgba[i + 1] = map(rgba[i + 1], kg);
    rgba[i + 2] = map(rgba[i + 2], kb);
  }

  return true;
}
