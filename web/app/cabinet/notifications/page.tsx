import type { Metadata } from "next";
import { notifications } from "../../../lib/cabinet";
import { formatDateTime } from "../../../lib/format";
import { gate } from "../Gate";

export const metadata: Metadata = {
  title: "Уведомления",
  robots: { index: false, follow: false },
};

const KIND_LABEL: Record<string, string> = {
  showing_ahead: "показ скоро",
  showing_soon: "через два часа",
  showing_overdue: "без исхода",
  showing_clash: "две группы у двери",
  showing_changed: "поправка",
};

/** Состояние определяет вид: очередь — ожидание, «не ушло» — тревога. */
const STATE_CLASS: Record<string, string> = {
  "в очереди": "chip",
  отправлено: "chip ok",
  "не ушло": "chip danger",
  погашено: "chip warn",
};

export default async function NotificationsPage() {
  const access = await gate();
  if (!access.ok) return access.screen;

  const all = await notifications();
  const stuck = all.filter((n) => n.state === "не ушло");
  const queued = all.filter((n) => n.state === "в очереди");
  const rest = all.filter((n) => n.state !== "не ушло" && n.state !== "в очереди");

  return (
    <div className="wrap">
      <h1>Уведомления</h1>
      <p className="lead">
        Что система вам сказала и что собирается сказать. Очередь видна
        целиком: «мне не пришло» должно иметь ответ, а «погашено, потому что
        показ перенесли» объясняет больше, чем молчание.
      </p>

      {all.length === 0 && (
        <p className="empty">
          Уведомлений нет. Они выпускаются по расписанию: накануне показа, за
          два часа до него, если показ прошёл без исхода и если к одной двери
          в один час идут двое.
        </p>
      )}

      {stuck.length > 0 && (
        <section>
          <h2 className="alarm">
            Не ушло <span className="muted">({stuck.length})</span>
          </h2>
          <p className="muted">
            Уведомление осталось в очереди: канал не принял его. Оно не
            потеряно и будет отправлено снова.
          </p>
          <Rows items={stuck} />
        </section>
      )}

      {queued.length > 0 && (
        <section>
          <h2>
            В очереди <span className="muted">({queued.length})</span>
          </h2>
          <Rows items={queued} />
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h2>
            История <span className="muted">({rest.length})</span>
          </h2>
          <Rows items={rest} />
        </section>
      )}
    </div>
  );
}

function Rows({ items }: { items: Awaited<ReturnType<typeof notifications>> }) {
  return (
    <div className="rows">
      {items.map((n) => (
        <article key={n.id} className={n.state === "не ушло" ? "row alarm" : "row"}>
          <div className="row-main">
            <p className="note">{n.body}</p>
            <p className="row-meta">
              <a href={`/cabinet/objects/${n.object_id}`}>{n.address}</a>
              {" · показ "}
              {formatDateTime(n.about_at)}
              {/* Уведомление говорит о том времени, которое было на момент
                  выпуска. Если показ с тех пор переехал, строка обязана это
                  сказать — иначе она противоречит собственному тексту. */}
              {n.moved_since && (
                <span className="act-err"> · сейчас {formatDateTime(n.scheduled_at)}</span>
              )}
            </p>
            {n.void_reason && <p className="muted">{n.void_reason}</p>}
            {n.last_error && <p className="act-err">{n.last_error}</p>}
          </div>

          <div className="row-state">
            <span className={STATE_CLASS[n.state] ?? "chip"}>{n.state}</span>
            <p className="muted">{KIND_LABEL[n.kind] ?? n.kind}</p>
          </div>

          <div className="row-acts">
            <p className="muted">
              {n.sent_at
                ? `отправлено ${formatDateTime(n.sent_at)}`
                : `в очереди с ${formatDateTime(n.created_at)}`}
              {n.attempts > 1 ? `, попыток ${n.attempts}` : ""}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}
