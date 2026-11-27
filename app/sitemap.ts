/**
 * Карта сайта: все четыре языка каждой страницы.
 *
 * Язык живёт в пути, и у каждого языка свой canonical (см. generateMetadata
 * страниц). Значит и в карте каждый адрес стоит отдельной записью, а внутри
 * записи — ссылки на остальные три языка плюс x-default. Это и есть
 * hreflang-кластер: без него поисковик считает четыре версии одной страницы
 * дублями и выбирает показываемую сам, обычно не ту.
 *
 * x-default ведёт на корень: там разбор Accept-Language, то есть посетителю
 * без понятного языка достанется наиболее подходящая версия, а не русская
 * по умолчанию.
 *
 * Источник объектов — витрина (`lib/db/catalog.ts`), единственное, что
 * положено публичной части: в ней нет ни комиссии, ни собственника, а из
 * полей агента — только три открытых сознательно. Снятые с публикации
 * объекты витрина не отдаёт, поэтому в карту попадает ровно то, что
 * открыто посетителю.
 *
 * Следствие, о которое легко споткнуться: опубликованный объект попадает в
 * карту сразу, без отдельного действия. Значит проверочный объект, заведённый
 * в боевой базе «на минуту», уходит роботам как настоящее объявление —
 * удалять его надо не «потом», а в том же сеансе.
 */
import type { MetadataRoute } from 'next';
import { catalogAgents, publishedIds } from '@/lib/db/catalog';
import { LANGS } from '@/lib/i18n';
import { siteUrl } from '@/lib/site';

/**
 * Предел карты по протоколу — 50 000 адресов. Каждый объект даёт четыре
 * записи, статических страниц восемь, поэтому берём с запасом вдвое: когда
 * объявлений станет больше, карту придётся делить на части через
 * generateSitemaps, и упереться в это лучше на отладке, чем в выдаче.
 */
const MAX_OBJECTS = 6000;

/**
 * Карта собирается на каждое обращение, без кеша.
 *
 * Кеш тут был бы обманом: запрос к базе идёт во время выполнения, и
 * страница всё равно считается динамической, сколько ни пиши revalidate.
 * Роботы заходят редко, один запрос к витрине на их визит ничего не стоит,
 * зато снятый с публикации объект исчезает из карты сразу, а не через час.
 */

type Row = { id: string; actual_at: string };

/**
 * Агенты, у которых есть что показать.
 *
 * Тот же список, что и на странице «Кто ведёт объекты»: витрина уже
 * отсекает неодобренных и тех, у кого нет опубликованных объектов, так
 * что в карту попадает ровно то, что отдаёт страница. Своего фильтра
 * здесь нет намеренно — второй список условий однажды разошёлся бы с
 * первым, и робот получал бы адреса, отвечающие 404.
 */
async function agentIds(): Promise<string[]> {
  try {
    return (await catalogAgents()).map((a) => a.id);
  } catch {
    return [];
  }
}

async function objects(): Promise<Row[]> {
  try {
    return (await publishedIds()).slice(0, MAX_OBJECTS);
  } catch {
    // База недоступна — отдаём карту со статическими страницами, а не 500.
    // Пустой sitemap.xml поисковик перечитает; ошибку он запомнит надолго.
    return [];
  }
}

/** Запись на каждый язык одного и того же пути, со ссылками друг на друга. */
function cluster(
  path: (lang: string) => string,
  lastModified: Date,
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'],
  priority: number,
): MetadataRoute.Sitemap {
  const languages: Record<string, string> = Object.fromEntries(
    LANGS.map((l) => [l, siteUrl(path(l))]),
  );
  languages['x-default'] = siteUrl('/');

  return LANGS.map((lang) => ({
    url: siteUrl(path(lang)),
    lastModified,
    changeFrequency,
    priority,
    alternates: { languages },
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [rows, agents] = await Promise.all([objects(), agentIds()]);
  const now = new Date();

  return [
    // Каталог. Содержимое меняется с каждым новым объявлением.
    ...cluster((l) => `/${l}`, now, 'daily', 1),

    // «Что я ищу»: форма, текст на ней меняется редко.
    ...cluster((l) => `/${l}/request`, now, 'monthly', 0.5),

    // Посадочная страница печатного QR-кода. Языковых версий у неё нет —
    // текст об объекте не переводится машиной, — поэтому не кластер, а одна
    // запись.
    {
      url: siteUrl('/chaika-resort'),
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    },

    // Список агентов и страница каждого.
    ...cluster((l) => `/${l}/agents`, now, 'weekly', 0.6),
    ...agents.flatMap((id) =>
      cluster((l) => `/${l}/agents/${id}`, now, 'weekly', 0.5),
    ),

    // Карточки объектов. lastModified — actual_at, дата последнего
    // подтверждения актуальности агентом: именно она говорит роботу,
    // что объявление живое, а не просто давно заведено.
    ...rows.flatMap((o) =>
      cluster(
        (l) => `/${l}/objects/${o.id}`,
        new Date(o.actual_at),
        'weekly',
        0.8,
      ),
    ),
  ];
}
