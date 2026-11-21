import type { Metadata } from "next";
import { tasks, taskTargets, me, type Task } from "../../../lib/cabinet";
import { plural } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { cancelTask, completeTask, createTask, rescheduleTask } from "../actions";

export const metadata: Metadata = {
  title: "Задачи",
  robots: { index: false, follow: false },
};

const KIND: Record<string, string> = {
  call: "Звонок",
  meeting: "Встреча",
  document: "Документы",
  other: "Дело",
};

const SUBJECT: Record<string, string> = {
  contact: "контакт",
  requirement: "клиент",
  object: "объект",
  deal: "сделка",
  inquiry: "обращение",
};

const BISHKEK = "Asia/Bishkek";

function when(value: Date | string): string {
  return new Date(value).toLocaleString("ru-RU", {
    timeZone: BISHKEK,
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayKey(value: Date | string): string {
  return new Date(value).toLocaleDateString("sv-SE", { timeZone: BISHKEK });
}

function inTwoHours(): string {
  const d = new Date(Date.now() + 6 * 3600 * 1000 + 2 * 3600 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 16);
}

function TaskRow({ task }: { task: Task }) {
  const closed = task.done_at !== null || task.cancelled_at !== null;

  return (
    <article className={task.overdue ? "trow overdue" : closed ? "trow closed" : "trow"}>
      <div className="tmain">
        <p className="ttitle">
          <span className="chip">{KIND[task.kind] ?? task.kind}</span> {task.title}
        </p>
        <p className="muted small">
          {when(task.due_at)}
          {task.subject_name &&
            ` · ${SUBJECT[task.subject_kind ?? ""] ?? "предмет"}: ${task.subject_name}`}
          {!task.is_mine && ` · исполняет ${task.agent_name}`}
        </p>
        {task.done_note && <p className="muted small">«{task.done_note}»</p>}
        {task.cancel_reason && <p className="muted small">снята: {task.cancel_reason}</p>}
      </div>

      {!closed && (
        <div className="tacts">
          <ActionForm action={completeTask} label="Сделано" className="act tight">
            <input type="hidden" name="task_id" value={task.id} />
            <input type="hidden" name="path" value="/cabinet/tasks" />
            <input name="note" placeholder="чем кончилось" maxLength={200} />
          </ActionForm>

          <details className="fold">
            <summary>Перенести</summary>
            <ActionForm action={rescheduleTask} label="Перенести" className="act tight">
              <input type="hidden" name="task_id" value={task.id} />
              <input type="hidden" name="path" value="/cabinet/tasks" />
              <input type="datetime-local" name="due_at" required />
              <span className="hint">
                Напоминание о старом сроке погаснет, о новом выпустится заново.
              </span>
            </ActionForm>
          </details>

          <details className="fold">
            <summary>Снять</summary>
            <ActionForm action={cancelTask} label="Снять" className="act tight" danger>
              <input type="hidden" name="task_id" value={task.id} />
              <input type="hidden" name="path" value="/cabinet/tasks" />
              <input name="reason" placeholder="почему" required maxLength={200} />
            </ActionForm>
          </details>
        </div>
      )}
    </article>
  );
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const [all, targets, agent] = await Promise.all([tasks(), taskTargets(), me()]);

  const open = all.filter((t) => t.done_at === null && t.cancelled_at === null);
  const closed = all.filter((t) => t.done_at !== null || t.cancelled_at !== null);
  const today = dayKey(new Date());
  const overdue = open.filter((t) => t.overdue);
  const todays = open.filter((t) => !t.overdue && dayKey(t.due_at) === today);
  const later = open.filter((t) => !t.overdue && dayKey(t.due_at) !== today);

  return (
    <div className="wrap">
      <h1>Задачи</h1>

      <p className="lead">
        Напоминание — это обещание со сроком: за полчаса до него придёт
        уведомление той же очередью, что и о показах. Задача о клиенте, сделке
        или обращении снимается сама, когда предмет закрыт: напоминание
        позвонить тому, кто уже купил, учит не читать напоминания.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      <section className="card">
        <h2>Новая задача</h2>
        <ActionForm action={createTask} label="Поставить" className="act form-grid">
          <input type="hidden" name="path" value="/cabinet/tasks" />
          <label>
            Что сделать
            <input name="title" placeholder="Перезвонить и назвать цену" required
                   maxLength={200} />
          </label>
          <label>
            Когда
            <input type="datetime-local" name="due_at" defaultValue={inTwoHours()} required />
            <span className="hint">по Бишкеку</span>
          </label>
          <label>
            Что это
            <select name="kind" defaultValue="call">
              <option value="call">Звонок</option>
              <option value="meeting">Встреча</option>
              <option value="document">Документы</option>
              <option value="other">Другое</option>
            </select>
          </label>
          <label>
            О ком
            <select name="requirement_id" defaultValue="">
              <option value="">без клиента</option>
              {targets.requirements.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            <span className="hint">
              Предмет один: задача и о клиенте, и об объекте не найдётся ни там,
              ни там.
            </span>
          </label>
          <label>
            Кому
            <select name="agent_id" defaultValue={agent?.id ?? ""}>
              {targets.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name}</option>
              ))}
            </select>
          </label>
        </ActionForm>
      </section>

      {overdue.length > 0 && (
        <>
          <h2 className="sec-overdue">
            Просрочено <span className="count">{overdue.length}</span>
          </h2>
          <p className="muted">
            Срок прошёл, а ответа нет. Молчание о задаче не значит, что её
            сделали.
          </p>
          {overdue.map((t) => <TaskRow key={t.id} task={t} />)}
        </>
      )}

      <h2>
        Сегодня <span className="count">{todays.length}</span>
      </h2>
      {todays.length === 0 ? (
        <p className="muted">На сегодня задач нет.</p>
      ) : (
        todays.map((t) => <TaskRow key={t.id} task={t} />)
      )}

      {later.length > 0 && (
        <>
          <h2>
            Дальше <span className="count">{later.length}</span>
          </h2>
          {later.map((t) => <TaskRow key={t.id} task={t} />)}
        </>
      )}

      {closed.length > 0 && (
        <>
          <h2>
            Закрытые <span className="count">{closed.length}</span>
          </h2>
          <p className="muted">
            Журнал звонков. Переписать его нельзя: закрытая задача
            окончательна, а передумали — заводится новая.
          </p>
          {closed.slice(0, 30).map((t) => <TaskRow key={t.id} task={t} />)}
        </>
      )}

      {all.length === 0 && (
        <p className="empty">
          Задач пока нет. Первая обычно одна и та же: перезвонить тому, кто
          написал сегодня.
        </p>
      )}
    </div>
  );
}
