import type { Metadata } from "next";
import { me } from "../../../lib/cabinet";
import { formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { updateMyName } from "../actions";

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
          <dt>Номер телефона</dt>
          <dd>
            {formatPhone(agent.phone)}
            <p className="hint">
              Номер — это учётная запись, поэтому поменять его правкой поля
              нельзя: новый номер подтверждается кодом, как при входе.
            </p>
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
          Имя и Telegram — единственное, что агент меняет сам. Статус и роль
          меняет администратор, и это запрещено не экраном, а правами на
          столбцы в базе.
        </p>
      </section>
    </div>
  );
}
