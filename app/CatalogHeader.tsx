import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';
import { LangSwitcher } from './LangSwitcher';
import logo from '../public/liberterra-dark.png';

/**
 * Шапка публичной части: знак, телефоны, язык, дверь для агентов.
 *
 * Тёмная и липкая. Тёмная — потому что под ней тёмный герой, и светлая
 * полоса резала бы страницу пополам. Липкая — потому что телефон нужен
 * человеку в тот момент, когда он решился, а не когда долистал наверх.
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
        <span className="spacer" />
        <div className="nav-phones">
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="nav-phone mono">{p.display}</a>
          ))}
        </div>
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
