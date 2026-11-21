import Link from 'next/link';
import { headers } from 'next/headers';
import { t, isLang, DEFAULT_LANG } from '@/lib/i18n';
import { CatalogHeader } from '../CatalogHeader';

/**
 * 404 внутри языкового участка.
 *
 * Язык здесь берётся из заголовка, который ставит middleware: params до
 * not-found.tsx не доходят — Next отрисовывает её вне маршрута.
 */
export default async function NotFound() {
  const raw = (await headers()).get('x-lang');
  const lang = isLang(raw) ? raw : DEFAULT_LANG;
  const d = t(lang);
  return (
    <>
      <CatalogHeader lang={lang} />
      <div className="pub-wrap">
        <h1>{d.notFound}</h1>
        <p className="sub">{d.notFoundLede}</p>
        <p><Link href={`/${lang}`}>{d.seeWhatIsThere}</Link></p>
      </div>
    </>
  );
}
