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
