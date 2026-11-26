import { redirect } from 'next/navigation';
import { sessionAgent } from '@/lib/db/session';
import { safeNext } from '@/lib/next-param';
import { LoginForm } from './LoginForm';

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
    <>
      <h1>Вход в кабинет</h1>
      <p className="sub">Кабинет агента открывается после одобрения администратором.</p>
      {error ? <p className="error">{decodeURIComponent(error)}</p> : null}
      <LoginForm next={target} />
    </>
  );
}
