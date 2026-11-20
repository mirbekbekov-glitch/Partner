import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ProfileForm } from './ProfileForm';

export const metadata = { title: 'Профиль' };

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/cabinet/profile');

  // Свою строку агент видит при любом статусе (политика agents_read_self).
  const { data: agent } = await supabase
    .from('agents')
    .select('full_name, phone, email, role, status, telegram_id, created_at')
    .eq('auth_user_id', user.id)
    .maybeSingle();

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
        />
      </div>

      {agent.telegram_id ? (
        <p className="key">Telegram: {agent.telegram_id}</p>
      ) : null}
    </>
  );
}
