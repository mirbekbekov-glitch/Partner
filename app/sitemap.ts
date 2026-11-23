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
 * Источник объектов — витрина public_catalog_v, единственная, что положена
 * публичной части: в ней нет ни комиссии, ни агента, ни собственника.
 * Снятые с публикации объекты витрина не отдаёт, поэтому в карту попадает
 * ровно то, что открыто посетителю.
 */
import type { MetadataRoute } from 'next';
import { createClient } from '@/lib/supabase/server';
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
 * Кеш тут был бы обманом: клиент Supabase читает куки, а это запрос
 * времени выполнения — страница всё равно считается динамической, сколько
 * ни пиши revalidate. Роботы заходят редко, один запрос к витрине на их
 * визит ничего не стоит, зато снятый с публикации объект исчезает из карты
 * сразу, а не через час.
 */

type Row = { id: string; actual_at: string };

async function objects(): Promise<Row[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('public_catalog_v')
      .select('id, actual_at')
      .order('actual_at', { ascending: false })
      .limit(MAX_OBJECTS);

    // База недоступна — отдаём карту со статическими страницами, а не 500.
    // Пустой sitemap.xml поисковик перечитает; ошибку он запомнит надолго.
    if (error) return [];
    return (data as Row[] | null) ?? [];
  } catch {
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
  const rows = await objects();
  const now = new Date();

  return [
    // Каталог. Содержимое меняется с каждым новым объявлением.
    ...cluster((l) => `/${l}`, now, 'daily', 1),

    // «Что я ищу»: форма, текст на ней меняется редко.
    ...cluster((l) => `/${l}/request`, now, 'monthly', 0.5),

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
