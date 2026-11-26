import { redirect } from 'next/navigation';
import { sessionAgent } from '@/lib/db/session';
import { getAgent, listOrganizations } from '@/lib/db/agents';
import { SignOutButton } from './SignOutButton';
import { CabinetSidebar } from './CabinetSidebar';
import './cabinet.css';
import { ProfileForm } from './profile/ProfileForm';

/**
 * Гейт кабинета.
 *
 * Middleware отсеял тех, у кого нет cookie вовсе. ЗДЕСЬ сессия впервые
 * сверяется с базой, и здесь же решается допуск по статусу агента.
 *
 * Это не единственная защита и не главная. Каждое действие слоя доступа
 * само зовёт requireAgent(), поэтому даже отрисуй мы страницы
 * неодобренному агенту, ни одна кнопка на них не сработала бы. Гейт нужен,
 * чтобы человек видел понятный экран, а не набор отказов.
 */
// Кабинет из поиска закрыт. Раньше это делал общий noindex в корневом
// макете, но он закрывал заодно и публичный каталог.
export const metadata = { robots: { index: false, follow: false } };

export default async function CabinetLayout({ children }: { children: React.ReactNode }) {
  // sessionAgent(), а не currentAgent(): неодобренному агенту нужно
  // показать экран ожидания, а не выставить его на улицу. Это разные
  // состояния, и человек должен понимать, в каком он.
  const agent = await sessionAgent();

  if (!agent) redirect('/login?next=/cabinet');

  const organization = agent.organization_id
    ? (await listOrganizations()).find((o) => o.id === agent.organization_id) ?? null
    : null;

  if (agent.status === 'blocked') {
    return (
      <Shell email={agent.email}>
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
    const knownOrgs = (await listOrganizations()).map((o) => o.name);
    return (
      <Shell email={agent.email}>
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
            organization={organization?.name ?? null}
            orgConfirmed={agent.org_confirmed === 1}
            knownOrgs={knownOrgs}
            hint="Это можно заполнить, не дожидаясь одобрения. Агентство подтвердит администратор."
          />
        </div>
      </Shell>
    );
  }

  return (
    <div className="crm-shell">
      <CabinetSidebar
        fullName={agent.full_name}
        isAdmin={agent.role === 'admin'}
        footer={<SignOutButton />}
      />
      <div className="crm-content">{children}</div>
    </div>
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
