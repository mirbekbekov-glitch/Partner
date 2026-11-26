import { redirect } from 'next/navigation';
import { sessionAgent } from '@/lib/db/session';
import { listOrganizations } from '@/lib/db/agents';
import { ProfileForm } from './ProfileForm';

export const metadata = { title: 'Профиль' };

export default async function ProfilePage() {
  // Свою строку агент видит при любом статусе: профиль заполняют и те, кто
  // ещё ждёт одобрения, — иначе админ не поймёт, кто подал заявку.
  const agent = await sessionAgent();
  if (!agent) redirect('/login?next=/cabinet/profile');

  // Список уже заведённых агентств — чтобы выбирали из существующих, а не
  // плодили написания.
  const organizations = await listOrganizations();
  const organization = agent.organization_id
    ? organizations.find((o) => o.id === agent.organization_id) ?? null
    : null;

  if (!agent) {
    return (
      <>
        <h1>Профиль</h1>
        <p className="error">
          Строка агента не найдена. Выйдите и войдите заново — она создаётся при входе.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Профиль</h1>
      <p className="sub">
        {agent.role === 'admin' ? 'Администратор' : 'Агент'} ·{' '}
        {agent.status === 'approved'
          ? 'доступ открыт'
          : agent.status === 'pending'
            ? 'ждёт одобрения'
            : 'доступ отозван'}
      </p>

      <div className="card">
        <ProfileForm
          fullName={agent.full_name}
          phone={agent.phone}
          email={agent.email}
          organization={organization?.name ?? null}
          orgConfirmed={agent.org_confirmed === 1}
          knownOrgs={organizations.map((o) => o.name)}
        />
      </div>

      <h2>Напоминания</h2>
      {agent.telegram_id ? (
        <p className="key">
          Telegram привязан ({agent.telegram_id}) — напоминания о задачах и показах
          придут туда.
        </p>
      ) : (
        <div className="card">
          <p className="warn">Telegram не привязан</p>
          <p>
            Напоминания о задачах и показах доставляются в Telegram. Без привязки они
            остаются в очереди и до вас не доходят.
          </p>
          <p className="key">
            Привязать может администратор: самостоятельная привязка требует
            подтверждения через бота, и она пока не сделана. Напишите админу свой
            Telegram ID — его показывает любой бот вроде @userinfobot.
          </p>
        </div>
      )}
    </>
  );
}
