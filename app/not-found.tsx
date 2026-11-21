import Link from 'next/link';
import { t, DEFAULT_LANG } from '@/lib/i18n';
import { CatalogHeader } from './CatalogHeader';

/**
 * 404 для адресов вне языкового участка — вроде /foo/bar.
 *
 * Языка в таком адресе нет и взять его негде, поэтому берётся язык по
 * умолчанию, а глобус в шапке даёт переключиться. Страницы внутри языка
 * обслуживает app/[lang]/not-found.tsx, где язык известен.
 */
const d = t(DEFAULT_LANG);

// Заголовок вкладки у 404 один на все языки: Next берёт его из корневой
// not-found, а она про язык адреса ничего не знает. Русское «Страница не
// найдена» во вкладке над китайской страницей выглядело бы ошибкой,
// поэтому здесь только имя — оно читается одинаково на всех четырёх.
export const metadata = { title: 'Liberterra' };

export default function NotFound() {
  return (
    <>
      <CatalogHeader lang={DEFAULT_LANG} />
      <div className="pub-wrap">
        <h1>{d.notFound}</h1>
        <p className="sub">{d.notFoundLede}</p>
        <p><Link href={`/${DEFAULT_LANG}`}>{d.seeWhatIsThere}</Link></p>
      </div>
    </>
  );
}
