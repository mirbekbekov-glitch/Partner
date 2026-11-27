/**
 * Сжатие снимка перед отправкой.
 *
 * Почему в браузере, а не на сервере. Преобразование изображений у
 * Cloudflare — отдельная платная услуга, на этом плане её не включить
 * (`image_resizing: off`, `editable: false`). В самом Worker'е картинку
 * пересобрать нечем: библиотеки изображений там нет, а тащить WASM ради
 * этого — лишний мегабайт в каждом запросе.
 *
 * Зато в браузере это бесплатно и выгоднее вдвойне: снимок с телефона на
 * 8 МБ не поедет по сети вовсе. Агент заводит объект с телефона, часто на
 * мобильном интернете, и это главный выигрыш — не место в хранилище, а
 * время загрузки.
 *
 * Делается ДВА файла: полный для карточки объекта и миниатюра для списка.
 * Каталог показывает по десятку карточек разом, и отдавать в них
 * двухтысячепиксельные снимки — это мегабайты ради картинки размером со
 * спичечный коробок.
 *
 * Модуль без 'server-only' намеренно: он работает в браузере и к базе не
 * обращается вовсе.
 */

import { checkPanorama, toGray, type Issue } from './photo-check';

/** Полный снимок: больше этого на экране не видно, а весит заметно. */
const FULL_SIDE = 2000;
const FULL_QUALITY = 0.82;

/** Миниатюра для карточки в списке. */
const THUMB_SIDE = 640;
const THUMB_QUALITY = 0.75;

export type Prepared = {
  full: Blob;
  thumb: Blob | null;
  /** Было и стало — чтобы показать человеку, что произошло. */
  before: number;
  after: number;
};

/** Умеет ли браузер пересобирать картинки. Старый — отправим как есть. */
function canResize(): boolean {
  return typeof createImageBitmap === 'function'
    && typeof OffscreenCanvas === 'function';
}

/** Во сколько раз уменьшить, чтобы длинная сторона стала не больше заданной. */
function scaleFor(width: number, height: number, side: number): number {
  const longest = Math.max(width, height);
  return longest > side ? side / longest : 1;
}

async function encode(
  bitmap: ImageBitmap,
  side: number,
  quality: number,
): Promise<Blob> {
  const scale = scaleFor(bitmap.width, bitmap.height, side);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('холст недоступен');

  context.drawImage(bitmap, 0, 0, width, height);

  // WebP, а не JPEG: при том же виде он меньше примерно на треть, и его
  // понимают все браузеры, которые умеют OffscreenCanvas.
  return canvas.convertToBlob({ type: 'image/webp', quality });
}

/**
 * Подготовить снимок к отправке.
 *
 * Если сжать не вышло — отдаём исходный файл без миниатюры. Потерять
 * снимок из-за неудачного сжатия хуже, чем отправить тяжёлый: агент
 * загружает его один раз, а объявление живёт месяцами.
 */
export async function prepare(file: File): Promise<Prepared> {
  if (!canResize()) {
    return { full: file, thumb: null, before: file.size, after: file.size };
  }

  try {
    const bitmap = await createImageBitmap(file);

    const [full, thumb] = await Promise.all([
      encode(bitmap, FULL_SIDE, FULL_QUALITY),
      encode(bitmap, THUMB_SIDE, THUMB_QUALITY),
    ]);

    bitmap.close();

    // Если «сжатый» вышел больше исходного — а так бывает с маленькими
    // снимками, уже сжатыми сильнее нашего, — отправляем исходный.
    const better = full.size < file.size ? full : file;

    return { full: better, thumb, before: file.size, after: better.size };
  } catch {
    return { full: file, thumb: null, before: file.size, after: file.size };
  }
}

/** «8,2 МБ» — для подписи под снимком. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * Миниатюра из снимка, который уже лежит в хранилище.
 *
 * Нужна пересчёту: у старых снимков и у снимков из браузеров без
 * OffscreenCanvas миниатюры нет, а исходного файла с телефона давно нет
 * тоже — есть только то, что в хранилище. Его и уменьшаем.
 *
 * Пусто означает «не смог»: браузер не умеет или файл не читается.
 * Пересчёт тогда просто пропускает снимок — остаться без миниатюры не
 * страшно, маршрут отдачи подставит полный.
 */
export async function thumbnailFrom(blob: Blob): Promise<Blob | null> {
  if (!canResize()) return null;

  try {
    const bitmap = await createImageBitmap(blob);
    const thumb = await encode(bitmap, THUMB_SIDE, THUMB_QUALITY);
    bitmap.close();
    return thumb;
  } catch {
    return null;
  }
}

/* --- Панорамы ------------------------------------------------------------
 *
 * У панорамы другие правила, чем у снимка. Её не рассматривают целиком:
 * просмотрщик показывает кусок в градусов шестьдесят, растягивая его на
 * весь экран. Сожми панораму до двух тысяч точек по длинной стороне, как
 * обычный снимок, — и в окне останется каша.
 *
 * 5120 — предел, после которого выигрыш в чёткости перестаёт
 * чувствоваться, а памяти в браузере телефона на пересборку уже не
 * хватает: площадь такой картинки около шести мегапикселей, и это
 * укладывается в ограничение холста на iOS.
 */
const PANO_SIDE = 5120;
const PANO_QUALITY = 0.8;

export type PreparedPano = {
  full: Blob;
  /** Размеры ПОСЛЕ сжатия: по ним просмотрщик считает углы обзора. */
  width: number;
  height: number;
  before: number;
  after: number;
  /** Что не так со съёмкой. Пусто — всё в порядке. */
  issues: Issue[];
};

export async function preparePanorama(file: File): Promise<PreparedPano> {
  const before = file.size;

  if (!canResize()) {
    // Старый браузер: отправляем как есть. Размеры неизвестны — пусть
    // просмотрщик считает панораму полной сферой, это частый случай.
    // Проверить съёмку тоже нечем, и молчание здесь честнее догадки.
    return { full: file, width: 0, height: 0, before, after: before, issues: [] };
  }

  const bitmap = await createImageBitmap(file);
  const scale = scaleFor(bitmap.width, bitmap.height, PANO_SIDE);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return {
      full: file, width: bitmap.width, height: bitmap.height,
      before, after: before, issues: [],
    };
  }

  context.drawImage(bitmap, 0, 0, width, height);

  // Проверка съёмки — на мелкой копии: на 256 точках видно и темноту, и
  // смазанность, а считается это миллисекунды даже на телефоне.
  const small = new OffscreenCanvas(256, Math.max(1, Math.round((256 * height) / width)));
  const smallCtx = small.getContext('2d');
  let gray = null;
  if (smallCtx) {
    smallCtx.drawImage(bitmap, 0, 0, small.width, small.height);
    const pixels = smallCtx.getImageData(0, 0, small.width, small.height);
    gray = toGray(pixels.data, small.width, small.height);
  }
  const issues = checkPanorama(gray, width, height);

  bitmap.close();

  const full = await canvas.convertToBlob({ type: 'image/jpeg', quality: PANO_QUALITY });
  return { full, width, height, before, after: full.size, issues };
}
