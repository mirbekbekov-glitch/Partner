import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';
import { LangSwitcher } from './LangSwitcher';
import { ThemeSwitch } from './ThemeSwitch';
import logo from '../public/liberterra.png';
import logoDark from '../public/liberterra-dark.png';

/**
 * Шапка публичной части: знак, заявки, язык, дверь для агентов.
 *
 * Светлая в светлой теме и тёмная в тёмной — вместе со страницей.
 * Знак при этом меняется на версию для тёмного фона: исходный красный
 * целиком и на тёмном читается плохо.
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
          {/* Два знака, переключаются темой. Исходный красный целиком, и
              на тёмной шапке он даёт 3.6 : 1 — для имени агентства мало.
              Во второй версии ступенька красная, слово белое. */}
          <Image src={logo} alt={AGENCY_NAME} className="on-light" priority />
          <Image src={logoDark} alt={AGENCY_NAME} className="on-dark" priority />
        </Link>
        {/* Единственный раздел рядом со знаком: человек, не нашедший
            объект в каталоге, не должен искать, куда написать. */}
        {/* Разделы в своей обёртке. На широком экране она прозрачна
            (display: contents) и ничего не меняет; на телефоне становится
            отдельной строкой целиком — иначе один из разделов остаётся
            наверху, а второй висит внизу один. */}
        <nav className="nav-sections">
          <Link href={`/${lang}/agents`} className="nav-link">{d.agentsNav}</Link>
          <Link href={`/${lang}/request`} className="nav-link">{d.reqNav}</Link>
        </nav>
        <span className="spacer" />
        <ThemeSwitch label={d.themeSwitch} />
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
