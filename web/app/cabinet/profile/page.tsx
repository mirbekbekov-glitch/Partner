import type { Metadata } from "next";
import { me } from "../../../lib/cabinet";
import { formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { updateMyName, updateMyPhone } from "../actions";

export const metadata: Metadata = {
  title: "Профиль",
  robots: { index: false, follow: false },
};

export default async function ProfilePage() {
  const access = await gate();
  if (!access.ok) return access.screen;

  const agent = await me();
  if (!agent) return null;

  return (
    <div className="wrap narrow">
      <h1>Профиль</h1>

      <section className="card">
        <dl className="facts">
          <dt>Адрес почты</dt>
          <dd>
            {agent.email}
            <p className="hint">
              Адрес — это учётная запись, поэтому поменять его правкой поля
              нельзя: новый адрес подтверждается кодом, как при входе.
            </p>
          </dd>
          <dt>Телефон</dt>
          <dd>
            {agent.phone ? formatPhone(agent.phone) : <span className="muted">не указан</span>}
            {agent.phone && !agent.phone_verified_at && (
              <span className="chip warn"> не подтверждён</span>
            )}
          </dd>
          <dt>Роль</dt>
          <dd>{agent.role === "admin" ? "администратор" : "агент"}</dd>
          <dt>Статус</dt>
          <dd>{agent.status === "approved" ? "работает" : agent.status}</dd>
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
          Имя, телефон и Telegram — то, что агент меняет сам. Адрес почты,
          статус и роль меняет администратор, и это запрещено не экраном, а
          правами на столбцы в базе.
        </p>
      </section>

      <section className="card">
        <h2>Телефон</h2>
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
    </div>
  );
}
