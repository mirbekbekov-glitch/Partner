import Link from 'next/link';

/**
 * Шапка публичной части. Вход для агентов — ссылкой, а не кнопкой: это
 * служебная дверь, а не то, ради чего человек пришёл в каталог.
 */
export function CatalogHeader() {
  return (
    <header className="pub-top">
      <Link href="/" className="pub-brand">Объекты в Бишкеке</Link>
      <Link href="/login" className="key">вход для агентов</Link>
    </header>
  );
}
