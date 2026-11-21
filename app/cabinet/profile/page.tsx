import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ProfileForm } from './ProfileForm';
import { orgName } from '@/lib/agency';

export const metadata = { title: 'Профиль' };

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/cabinet/profile');

  // Свою строку агент видит при любом статусе (политика agents_read_self).
  const { data: agent } = await supabase
    .from('agents')
    .select('full_name, phone, email, role, status, telegram_id, created_at, org_confirmed, organizations!agents_organization_id_fkey(name)')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  // Список уже заведённых агентств — чтобы выбирали из существующих, а не
  // плодили написания. Видят его все вошедшие (политика organizations_read).
  const { data: orgs } = await supabase
    .from('organization_list_v')
    .select('name')
    .limit(200);

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
          organization={orgName(agent.organizations)}
          orgConfirmed={agent.org_confirmed}
          knownOrgs={(orgs ?? []).map((o) => o.name as string)}
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
