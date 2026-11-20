import Link from 'next/link';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';

/**
 * Шапка публичной части.
 *
 * Телефоны стоят рядом с названием: в каталоге недвижимости звонок — то, ради
 * чего человек пришёл, и искать номер в подвале он не станет. Все три видны
 * сразу, без «показать ещё»: это разные операторы, и человек выбирает тот,
 * что дешевле ему, а не первый попавшийся.
 *
 * Вход для агентов — ссылкой в конце: служебная дверь, а не то, зачем сюда
 * приходят.
 */
export function CatalogHeader() {
  return (
    <header className="pub-top">
      <Link href="/" className="pub-brand">{AGENCY_NAME}</Link>

      <div className="pub-phones">
        {AGENCY_PHONES.map((p) => (
          <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
        ))}
      </div>

      <Link href="/login" className="key pub-agents">вход для агентов</Link>
    </header>
  );
}
