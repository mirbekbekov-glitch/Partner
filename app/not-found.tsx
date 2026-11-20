import Link from 'next/link';
import { CatalogHeader } from './CatalogHeader';

export const metadata = { title: 'Страница не найдена' };

export default function NotFound() {
  return (
    <>
      <CatalogHeader />
      <h1>Страница не найдена</h1>
      <p className="sub">
        Возможно, объект сняли с публикации или продали.
      </p>
      <p><Link href="/">Посмотреть, что есть сейчас →</Link></p>
    </>
  );
}
