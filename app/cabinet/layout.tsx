import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SignOutButton } from './SignOutButton';

/**
 * Гейт кабинета.
 *
 * Сессию уже проверил middleware, здесь решается допуск по статусу агента.
 * Это только удобство UI: настоящая защита — RLS. Даже если отрисовать
 * страницы неодобренному агенту, политики не отдадут ему ни одной строки.
 */
export default async function CabinetLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login?next=/cabinet');

  const { data: agent } = await supabase
    .from('agents')
    .select('id, full_name, email, role, status')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  // Неодобренный агент не читает даже таблицу agents, поэтому agent здесь
  // будет null не только когда строки нет, но и когда она есть со статусом
  // pending. Различить два случая без service_role нельзя, и это к лучшему:
  // обоим показывается один и тот же экран ожидания.
  if (!agent) {
    return (
      <>
        <h1>Заявка на доступ отправлена</h1>
        <p className="sub">{user.email}</p>
        <div className="card">
          <p>Кабинет откроется, когда администратор одобрит ваш аккаунт.</p>
          <p className="key">
            Если одобрение уже получено, обновите страницу. Если доступ был
            отозван — обратитесь к администратору.
          </p>
        </div>
        <SignOutButton />
      </>
    );
  }

  return (
    <>
      <nav className="topbar">
        <span className="who">
          {agent.full_name}
          {agent.role === 'admin' ? <span className="tag">админ</span> : null}
        </span>
        {agent.role === 'admin' ? (
          <Link href="/cabinet/admin/agents">Агенты</Link>
        ) : null}
        <SignOutButton />
      </nav>
      {children}
    </>
  );
}
