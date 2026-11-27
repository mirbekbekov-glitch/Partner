import 'server-only';

/**
 * Адрес → координаты.
 *
 * Зачем вообще. Площадки не принимают объявление без координат, а вводить
 * широту и долготу руками агент не будет: это не его работа и не его
 * язык. Поэтому координаты берутся двумя путями — точкой на карте и
 * догадкой по адресу, которую агент видит на той же карте и может
 * поправить. Догадка никогда не сохраняется молча.
 *
 * Почему с сервера, а не из браузера. Во-первых, у службы геокодирования
 * есть правила: она просит называть приложение и не ходить к ней часто.
 * С сервера мы называем себя честно одним именем, а не именем чужого
 * браузера. Во-вторых, из браузера к ней ушёл бы IP агента, а это его
 * данные, а не наши.
 *
 * Служба — OpenStreetMap: единственная, которая не требует ключа и
 * разрешает такое использование. Её ответ — предположение, а не истина:
 * «Чүй 120» в Бишкеке она найдёт, «дом за гаражами» — нет, и тогда
 * агент ставит точку сам.
 */

export type Spot = { lat: number; lon: number; label: string };

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Как мы представляемся службе. Без этого она вправе не отвечать. */
const UA = 'Liberterra/1.0 (real estate catalog; +https://liberterra.kg)';

export async function geocode(query: string): Promise<Spot | null> {
  const q = query.trim();
  if (q.length < 3) return null;

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  // Язык ответа тот же, на котором спрашивали: подпись под картой
  // должна читаться агентом, а не быть латиницей.
  url.searchParams.set('accept-language', 'ru');

  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    // Один и тот же адрес ищут не по разу: правка объекта, вторая
    // попытка, соседняя квартира в том же доме.
    cf: { cacheTtl: 86400, cacheEverything: true },
  } as RequestInit);

  if (!response.ok) return null;

  const data = await response.json() as Array<{
    lat?: string; lon?: string; display_name?: string;
  }>;

  const first = Array.isArray(data) ? data[0] : null;
  if (!first?.lat || !first?.lon) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { lat, lon, label: first.display_name ?? q };
}
