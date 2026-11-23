import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { publicSupabaseConfig } from '@/lib/supabase/public-config';
import { safeNext } from '@/lib/next-param';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Вход в кабинет', robots: { index: false, follow: false } };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Уже вошёл — незачем показывать форму. Но если вход принёс ошибку, её
  // надо показать: иначе причина теряется. Так и случилось на живом проекте —
  // /auth/confirm отправлял сюда понятный текст про занятую почту, а эта
  // строка молча уводила в кабинет, и человек видел лишь «аккаунт не найден».
  if (user && !error) redirect(next ?? '/cabinet');

  const target = safeNext(next);

  return (
    <>
      <h1>Вход в кабинет</h1>
      <p className="sub">Кабинет агента открывается после одобрения администратором.</p>
      {error ? <p className="error">{decodeURIComponent(error)}</p> : null}
      <LoginForm next={target} supabase={publicSupabaseConfig()} />
    </>
  );
}
