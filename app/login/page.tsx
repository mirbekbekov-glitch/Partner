import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Вход в кабинет' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Уже вошёл — незачем показывать форму.
  if (user) redirect(next ?? '/cabinet');

  // next берём только как относительный путь: иначе ссылка вида
  // /login?next=https://… увела бы человека на чужой сайт после входа.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/cabinet';

  return (
    <>
      <h1>Вход в кабинет</h1>
      <p className="sub">Кабинет агента открывается после одобрения администратором.</p>
      {error ? <p className="error">{decodeURIComponent(error)}</p> : null}
      <LoginForm next={safeNext} />
    </>
  );
}
