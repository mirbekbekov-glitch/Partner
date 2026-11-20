import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SignOutButton } from './SignOutButton';
import { ProfileForm } from './profile/ProfileForm';

/**
 * Гейт кабинета.
 *
 * Сессию проверил middleware, здесь решается допуск по статусу агента.
 * Это удобство UI, не защита: настоящая защита — RLS. Даже отрисуй мы
 * страницы неодобренному агенту, политики не отдали бы ему ни строки.
 *
 * Статус читается благодаря политике agents_read_self (0013): до неё
 * неодобренный агент не видел даже себя, и «строки нет» было не отличить
 * от «ждёт одобрения» — оба случая получали один экран.
 */
// Кабинет из поиска закрыт. Раньше это делал общий noindex в корневом
// макете, но он закрывал заодно и публичный каталог.
export const metadata = { robots: { index: false, follow: false } };

export default async function CabinetLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login?next=/cabinet');

  const { data: agent } = await supabase
    .from('agents')
    .select('id, full_name, phone, email, role, status')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  // Строки нет: ensure_agent() при входе не сработал.
  if (!agent) {
    return (
      <Shell email={user.email}>
        <h1>Аккаунт не найден</h1>
        <p className="error">
          Запись агента не создалась при входе. Выйдите и войдите заново.
        </p>
      </Shell>
    );
  }

  if (agent.status === 'blocked') {
    return (
      <Shell email={agent.email ?? user.email}>
        <h1>Доступ отозван</h1>
        <div className="card">
          <p>Ваш доступ к CRM закрыт администратором.</p>
          <p className="key">
            Контакты и объекты, которые вы вели, сохранены и остались за вами —
            ничего не потеряно.
          </p>
        </div>
      </Shell>
    );
  }

  if (agent.status === 'pending') {
    return (
      <Shell email={agent.email ?? user.email}>
        <h1>Заявка на доступ отправлена</h1>
        <div className="card">
          <p>Кабинет откроется, когда администратор одобрит ваш аккаунт.</p>
          <p className="key">Если одобрение уже получено — обновите страницу.</p>
        </div>

        {/* Пока ждёт — пусть впишет имя: админ видит эту строку в списке
            заявок и иначе не поймёт, кто её подал. */}
        <h2>Как вас записать</h2>
        <div className="card">
          <ProfileForm
            fullName={agent.full_name}
            phone={agent.phone}
            email={agent.email}
            hint="Это можно заполнить, не дожидаясь одобрения."
          />
        </div>
      </Shell>
    );
  }

  return (
    <>
      <nav className="topbar">
        <span className="who">
          <Link href="/cabinet">Кабинет</Link>
          <Link href="/cabinet/contacts">Контакты</Link>
          <Link href="/cabinet/objects">Объекты</Link>
          <Link href="/cabinet/requirements">Потребности</Link>
          <Link href="/cabinet/deals">Сделки</Link>
          <Link href="/cabinet/activities">Задачи</Link>
        </span>
        {agent.role === 'admin' ? <Link href="/cabinet/admin/agents">Агенты</Link> : null}
        <Link href="/cabinet/profile">{agent.full_name}</Link>
        {agent.role === 'admin' ? <span className="tag">админ</span> : null}
        <SignOutButton />
      </nav>
      {children}
    </>
  );
}

/** Полоса без навигации: внутрь кабинета таким агентам ходить некуда. */
function Shell({ email, children }: { email?: string | null; children: React.ReactNode }) {
  return (
    <>
      <nav className="topbar">
        <span className="who key">{email}</span>
        <SignOutButton />
      </nav>
      {children}
    </>
  );
}
