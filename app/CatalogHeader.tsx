import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';
import { LangSwitcher } from './LangSwitcher';
import logo from '../public/liberterra.png';

/**
 * Шапка публичной части: знак, телефоны, язык, служебная дверь для агентов.
 *
 * Подписи рядом со знаком нет — в нём уже написано «Liberterra». Телефоны
 * стоят тут же: в каталоге недвижимости звонок — то, ради чего человек
 * пришёл. Все три сразу, это разные операторы.
 */
export function CatalogHeader({ lang }: { lang: Lang }) {
  const d = t(lang);
  return (
    <header className="pub-top">
      <div className="pub-top-in">
        <Link href={`/${lang}`} className="pub-brand" aria-label={`${AGENCY_NAME} — ${d.toAll}`}>
          <Image src={logo} alt={AGENCY_NAME} className="pub-logo" priority />
        </Link>
        <div className="pub-phones">
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
          ))}
        </div>
        <LangSwitcher lang={lang} />
        <Link href="/login" className="pub-agents">{d.forAgents}</Link>
      </div>
    </header>
  );
}
