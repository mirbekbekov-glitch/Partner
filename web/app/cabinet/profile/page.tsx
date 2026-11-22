import type { Metadata } from "next";
import { me } from "../../../lib/cabinet";
import { formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { updateMyName, updateMyPhone, updateMyTelegram } from "../actions";

export const metadata: Metadata = {
  title: "Профиль",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, string> = {
  admin: "администратор",
  head: "руководитель",
  agent: "агент",
};

const STATUS_LABEL: Record<string, string> = {
  approved: "работает",
  pending: "ждёт одобрения",
  blocked: "заблокирован",
};

const DIRECTION_LABEL: Record<string, string> = {
  sale: "продажа",
  rent: "аренда",
};

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const agent = await me();
  if (!agent) return null;

  return (
    <div className="wrap narrow">
      <h1>Профиль</h1>

      <p className="lead">
        Здесь ровно две части, и граница между ними — не оформление. Сверху
        то, что про вас решила компания: агентство, роль, направления,
        доступ. Ниже — то, что вы меняете сами. Запрещает правку не этот
        экран, а права на столбцы в базе: форма, которой здесь нет, всё
        равно получила бы отказ.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      <section className="card">
        <h2>Что решила компания</h2>
        <dl className="facts">
          <dt>Агентство</dt>
          <dd>
            {agent.agency_name}
            <p className="hint">
              Клиенты, договоры и подборы принадлежат агентству, а объекты
              видны всей платформе. Перевод в другое агентство — это не
              правка профиля, а новая работа.
            </p>
          </dd>

          <dt>Роль</dt>
          <dd>
            {ROLE_LABEL[agent.role] ?? agent.role}
            {agent.is_head && <span className="chip info">видит всё агентство</span>}
            {agent.is_admin && <span className="chip admin">админ</span>}
            {agent.is_head && (
              <p className="hint">
                Руководитель видит работу всего агентства и может в ней всё:
                двинуть чужой объект по этапам, заключить договор, закрыть
                чужую задачу, передать работу.
              </p>
            )}
          </dd>

          <dt>Направления</dt>
          <dd>
            {agent.directions.length === 0 ? (
              <span className="chip danger">не заданы</span>
            ) : (
              agent.directions.map((d) => (
                <span key={d} className="chip">{DIRECTION_LABEL[d] ?? d}</span>
              ))
            )}
            <p className="hint">
              Направление — не ярлык: агент отдела аренды не видит работу
              отдела продаж. Назначает их руководитель.
            </p>
          </dd>

          <dt>Доступ</dt>
          <dd>
            <span
              className={`chip ${
                agent.status === "approved"
                  ? "ok"
                  : agent.status === "pending"
                    ? "warn"
                    : "danger"
              }`}
            >
              {STATUS_LABEL[agent.status] ?? agent.status}
            </span>
          </dd>

          <dt>Адрес почты</dt>
          <dd>
            {agent.email}
            <p className="hint">
              Адрес — это учётная запись, поэтому поменять его правкой поля
              нельзя: новый адрес подтверждается кодом, как при входе.
            </p>
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>Имя</h2>
        <ActionForm action={updateMyName} label="Сохранить">
          <label>
            Имя и фамилия
            <input name="full_name" defaultValue={agent.full_name} required />
          </label>
        </ActionForm>
        <p className="hint">
          Его видят коллеги во всех агентствах: рядом с вашим объектом в
          общем списке стоит именно оно.
        </p>
      </section>

      <section className="card">
        <h2>Телефон</h2>
        <p className="muted">
          {agent.phone ? formatPhone(agent.phone) : "не указан"}
          {agent.phone && !agent.phone_verified_at && (
            <span className="chip warn">не подтверждён</span>
          )}
        </p>
        <ActionForm action={updateMyPhone} label="Сохранить">
          <label>
            Номер телефона
            <input
              name="phone"
              type="tel"
              defaultValue={agent.phone ?? ""}
              placeholder="0700 123 456"
              autoComplete="tel"
            />
          </label>
        </ActionForm>
        <p className="hint">
          Номер записан с ваших слов и помечен неподтверждённым: подтвердить
          его нечем, пока не подключён WhatsApp. Ни одно правило системы на
          него не опирается — он нужен коллегам и клиентам, чтобы до вас
          дозвониться. Смена номера сбрасывает подтверждение, когда оно
          появится.
        </p>
      </section>

      <section className="card">
        <h2>Telegram</h2>
        {/* Поле, которого на этом экране не было, хотя подпись рядом его
            обещала. Оно не украшение: очередь уведомлений отдаёт сообщения
            по telegram_id, и агент без него не получает ничего — молча. */}
        <p className="muted">
          {agent.telegram_id ? (
            <>
              привязан <code>{agent.telegram_id}</code>
            </>
          ) : (
            <span className="chip warn">не привязан — уведомления не придут</span>
          )}
        </p>
        <ActionForm action={updateMyTelegram} label="Сохранить">
          <label>
            Telegram ID
            <input
              name="telegram_id"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={agent.telegram_id ?? ""}
              placeholder="123456789"
            />
          </label>
        </ActionForm>
        <p className="hint">
          Это число, а не имя пользователя: его присылает бот платформы при
          первом сообщении ему. Пустое поле отвязывает Telegram, и
          уведомления туда приходить перестанут. Один аккаунт Telegram может
          принадлежать только одному агенту.
        </p>
      </section>
    </div>
  );
}
