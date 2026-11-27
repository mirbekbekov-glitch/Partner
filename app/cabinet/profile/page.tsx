import { redirect } from 'next/navigation';
import { sessionAgent } from '@/lib/db/session';
import { listOrganizations } from '@/lib/db/agents';
import { ProfileForm } from './ProfileForm';
import { AvatarUpload } from './AvatarUpload';
import { TelegramLink } from './TelegramLink';

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
        {/* Отдельно от формы намеренно: снимок уходит в хранилище сразу,
            а не ждёт кнопки «Сохранить». Так же устроена загрузка снимков
            объекта, и по той же причине — ждать отправки файла, прежде
            чем увидеть его, ощущается как зависшая страница. */}
        <AvatarUpload initial={agent.avatar_key ? `/photos/${agent.avatar_key}` : null} />

        <ProfileForm
          fullName={agent.full_name}
          phone={agent.phone}
          whatsapp={agent.whatsapp === 1}
          telegramUser={agent.telegram_user}
          email={agent.email}
          organization={organization?.name ?? null}
          orgConfirmed={agent.org_confirmed === 1}
          knownOrgs={organizations.map((o) => o.name)}
          worksSince={agent.works_since}
          certificateNo={agent.certificate_no}
          certificateConfirmed={agent.certificate_confirmed === 1}
        />
      </div>

      <h2>Напоминания</h2>
      <div className="card">
        <p>
          Напоминания о задачах и показах доставляются в Telegram. Без привязки они
          остаются в очереди и до вас не доходят.
        </p>
        {/* Привязывает сам агент: бот получает от Telegram настоящий
            идентификатор отправителя, и подделать его нельзя. Раньше это
            делал админ по присланному номеру — и верил человеку на слово,
            проверить номер было нечем. */}
        <TelegramLink linked={agent.telegram_id} />
      </div>
    </>
  );
}
