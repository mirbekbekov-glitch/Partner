import Link from 'next/link';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { sessionAgent } from '@/lib/db/session';
import { safeNext } from '@/lib/next-param';
import { AGENCY_NAME } from '@/lib/agency';
import { LoginForm } from './LoginForm';
import logo from '../../public/liberterra.png';
import logoDark from '../../public/liberterra-dark.png';

export const metadata = { title: 'Вход в кабинет', robots: { index: false, follow: false } };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const agent = await sessionAgent();

  // Уже вошёл — незачем показывать форму. Но если вход принёс ошибку, её
  // надо показать: иначе причина теряется. Так уже случалось на живом
  // проекте — маршрут входа присылал сюда понятный текст, а эта строка
  // молча уводила в кабинет, и человек видел лишь «аккаунт не найден».
  if (agent && !error) redirect(next ?? '/cabinet');

  const target = safeNext(next);

  return (
    <div className="auth">
      <div className="auth-box">
        {/* Знак здесь и за тем, чтобы человек видел, куда он вошёл, и за
            тем, чтобы с этой страницы был путь назад: она открывается по
            ссылке из письма и из шапки каталога, и упереться в неё
            тупиком не должно. */}
        <Link href="/" className="brand auth-brand" aria-label={AGENCY_NAME}>
          <Image src={logo} alt={AGENCY_NAME} className="on-light" priority />
          <Image src={logoDark} alt={AGENCY_NAME} className="on-dark" priority />
        </Link>

        <div className="auth-card">
          <h1>Вход в кабинет</h1>
          <p className="auth-sub">
            Кабинет агента открывается после одобрения администратором.
          </p>
          {error ? <p className="error">{decodeURIComponent(error)}</p> : null}
          <LoginForm next={target} />
        </div>

        <p className="auth-back">
          <Link href="/">← Вернуться в каталог</Link>
        </p>
      </div>
    </div>
  );
}
