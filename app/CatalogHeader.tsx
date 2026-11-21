import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import logo from '../public/liberterra.png';

/**
 * Шапка публичной части: знак, телефоны, служебная дверь для агентов.
 *
 * Подписи рядом со знаком нет — в нём уже написано «Liberterra». Телефоны
 * стоят тут же: в каталоге недвижимости звонок — то, ради чего человек
 * пришёл. Все три сразу, это разные операторы.
 */
export function CatalogHeader() {
  return (
    <header className="pub-top">
      <div className="pub-top-in">
        <Link href="/" className="pub-brand" aria-label={`${AGENCY_NAME} — на главную`}>
          <Image src={logo} alt={AGENCY_NAME} className="pub-logo" priority />
        </Link>
        <div className="pub-phones">
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
          ))}
        </div>
        <Link href="/login" className="pub-agents">Вход для агентов</Link>
      </div>
    </header>
  );
}
