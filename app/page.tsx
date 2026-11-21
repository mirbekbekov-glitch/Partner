import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { LANGS, DEFAULT_LANG, type Lang } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * Корень уводит на язык.
 *
 * Своей страницы у «/» нет намеренно: иначе у каталога было бы пять
 * адресов вместо четырёх, и поисковик не знал бы, какой из них главный.
 *
 * Язык выбирается по заголовку браузера — гость из Урумчи попадает на
 * китайскую версию, не нажимая глобус. Дальше выбор за ним: переключатель
 * меняет адрес, и ссылка уже везёт язык с собой.
 */
function preferred(header: string | null): Lang {
  if (!header) return DEFAULT_LANG;
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .filter((x) => Number.isFinite(x.q))
    .sort((a, b) => b.q - a.q);

  for (const { tag } of wanted) {
    // «zh-CN» и «zh-Hans» — тот же китайский: сравниваем по первой части.
    const base = tag.split('-')[0];
    const hit = LANGS.find((l) => l === base);
    if (hit) return hit;
  }
  return DEFAULT_LANG;
}

export default async function Root() {
  redirect(`/${preferred((await headers()).get('accept-language'))}`);
}
