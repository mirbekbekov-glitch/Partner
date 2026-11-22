/**
 * Собственный адрес сайта: один источник на все абсолютные ссылки.
 *
 * Карте сайта, robots.txt и превью при пересылке нужен АБСОЛЮТНЫЙ адрес:
 * относительный в sitemap.xml запрещён протоколом, а og:image по
 * относительному пути мессенджер просто не загрузит. Брать его из
 * заголовка Host нельзя — тот приходит от посетителя и у превью-сборок
 * указывает на одноразовый поддомен, который потом попадёт в выдачу.
 *
 * Порядок источников:
 *   NEXT_PUBLIC_SITE_URL            — боевой адрес, задаётся руками;
 *   VERCEL_PROJECT_PRODUCTION_URL   — боевой домен проекта, его Vercel
 *                                     подставляет и в превью-сборках,
 *                                     поэтому превью не уводит выдачу
 *                                     на себя;
 *   http://localhost:3000           — разработка.
 *
 * Намеренно НЕ берём VERCEL_URL: это адрес конкретной сборки.
 */
const FALLBACK = 'http://localhost:3000';

function resolve(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit;

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production}`;

  return FALLBACK;
}

/** Адрес без косой черты на конце: `https://example.com`. */
export const SITE_URL = resolve().replace(/\/+$/, '');

/** Абсолютная ссылка на путь внутри сайта: `siteUrl('/ru')`. */
export function siteUrl(path = '/'): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
