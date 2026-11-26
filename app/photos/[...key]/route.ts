import { readPhoto } from '@/lib/db/photos';

/**
 * Отдача снимков из R2.
 *
 * Через свой маршрут, а не прямым адресом R2. Так ведро остаётся закрытым,
 * а адрес снимка не привязан ни к имени ведра, ни к аккаунту: сменится
 * хранилище — адреса в объявлениях не изменятся.
 *
 * Снимки публичны по существу: они в объявлениях. Отдельной проверки прав
 * здесь нет и быть не должно — иначе каталог показывал бы их только
 * вошедшим. Снимки черновика тоже доступны по ссылке, но ключ случайный и
 * ниоткуда не публикуется, пока объект не опубликован.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const photo = await readPhoto(key.join('/'));

  if (!photo) {
    return new Response('Не найдено', { status: 404 });
  }

  // Ключ случайный и неизменный: содержимое по нему никогда не меняется,
  // поэтому кеш навсегда. Повторная загрузка того же снимка получит новый
  // ключ, а не перезапишет старый.
  return new Response(photo.body, {
    headers: {
      'content-type': photo.type,
      'content-length': String(photo.size),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: photo.etag,
    },
  });
}
