import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';
import { LangSwitcher } from './LangSwitcher';
import logo from '../public/liberterra-dark.png';

/**
 * Шапка публичной части: знак, заявки, язык, дверь для агентов.
 *
 * Тёмная и липкая. Тёмная — потому что под ней тёмный герой, и светлая
 * полоса резала бы страницу пополам.
 *
 * Телефонов здесь нет намеренно: три номера в ряд перетягивали на себя
 * верх страницы. Они остались в подвале и в карточке объекта — то есть
 * там, где человек уже выбрал, кому звонить.
 *
 * Знак здесь во второй версии фирменного блока: ступенька красная, слово
 * белое. Исходный блок красный целиком и на чёрном даёт 3.6 : 1 — для
 * имени агентства мало.
 */
export function CatalogHeader({ lang }: { lang: Lang }) {
  const d = t(lang);
  return (
    <header className="nav">
      <div className="nav-in wrap">
        <Link href={`/${lang}`} className="brand" aria-label={AGENCY_NAME}>
          <Image src={logo} alt={AGENCY_NAME} priority />
        </Link>
        {/* Единственный раздел рядом со знаком: человек, не нашедший
            объект в каталоге, не должен искать, куда написать. */}
        <Link href={`/${lang}/request`} className="nav-link">{d.reqNav}</Link>
        <span className="spacer" />
        <LangSwitcher lang={lang} />
        <Link href="/login" className="enter">
          {/* На узком экране подпись короче: полная не влезала в строку и
              сталкивала телефоны на третий ряд. */}
          <span className="wide">{d.forAgents}</span>
          <span className="narrow">{d.forAgentsShort}</span>
        </Link>
      </div>
    </header>
  );
}
