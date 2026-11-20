import type { Metadata } from "next";
import { schedulerHealth } from "../../../lib/cabinet";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { runMaintenance } from "../actions";

export const metadata: Metadata = {
  title: "Расписание",
  robots: { index: false, follow: false },
};

export default async function SchedulerPage() {
  const access = await gate();
  if (!access.ok) return access.screen;

  const jobs = await schedulerHealth();
  const broken = jobs.filter((j) => j.status !== "в норме" && j.status !== "выключена");

  return (
    <div className="wrap">
      <h1>Расписание</h1>
      <p className="lead">
        Три инварианта держатся на этих работах: договор истекает по дате,
        закрепление за агентом снимается по сроку, телефон собственника
        удаляется по сроку хранения. Главная опасность здесь — не ошибка, а
        тишина: не запущенная работа не даёт сообщений, система просто
        перестаёт делать обещанное.
      </p>

      {broken.length === 0 ? (
        <p className="ok-banner">Все работы идут по расписанию.</p>
      ) : (
        <p className="warn">
          Не в норме: {broken.length}. Если это «ни разу не запускалась» —
          планировщик не включён: <code>db/install_schedule.sql</code>.
        </p>
      )}

      <div className="rows">
        {jobs.map((j) => (
          <article key={j.job} className={j.status !== "в норме" && j.status !== "выключена" ? "row alarm" : "row"}>
            <div className="row-main">
              <h3><code>{j.job}</code></h3>
              <p className="row-meta">{j.description}</p>
              <p className="muted">
                расписание <code>{j.cron_expression}</code>
                {j.silence ? ` · молчит ${j.silence}` : ""}
              </p>
              {j.last_error && <p className="act-err">{j.last_error}</p>}
            </div>
            <div className="row-state">
              <span className={j.status === "в норме" ? "chip ok" : "chip danger"}>{j.status}</span>
            </div>
            {access.agent.is_admin && (
              <div className="row-acts">
                <ActionForm action={runMaintenance} label="Запустить сейчас">
                  <input type="hidden" name="job" value={j.job} />
                </ActionForm>
              </div>
            )}
          </article>
        ))}
      </div>

      {access.agent.is_admin && (
        <section className="card">
          <h2>Запустить всё</h2>
          <p>
            Работы идемпотентны: лишний проход просто ничего не находит.
          </p>
          <ActionForm action={runMaintenance} label="Запустить все работы" />
        </section>
      )}
    </div>
  );
}
