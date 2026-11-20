import type { Metadata } from "next";
import { showings, type Showing } from "../../../lib/cabinet";
import {
  formatDateTime,
  formatPrice,
  OUTCOME_LABEL,
  plural,
  SHOWING_LABEL,
} from "../../../lib/format";
import { gate } from "../Gate";
import { ShowingCard } from "../ShowingCard";

export const metadata: Metadata = {
  title: "Показы",
  robots: { index: false, follow: false },
};

/** Время показа — без даты: дата стоит заголовком дня. */
function clock(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString("ru-RU", {
    timeZone: "Asia/Bishkek",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Заголовок дня.
 *
 * «Сегодня» и «завтра» вместо даты — не украшение: агент смотрит этот экран,
 * чтобы понять, куда ехать сейчас, и перевод «24.11» в «это сегодня?» он
 * делать не должен.
 */
function dayTitle(day: string, today: string, tomorrow: string): string {
  if (day === today) return "Сегодня";
  if (day === tomorrow) return "Завтра";
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString("ru-RU", {
    timeZone: "Asia/Bishkek",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Дата в поясе агентства, строкой YYYY-MM-DD. */
function bishkekDay(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: "Asia/Bishkek" });
}

/** on_day из вида приходит как Date (драйвер pg) или как строка. */
function dayKey(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toLocaleDateString("en-CA", { timeZone: "Asia/Bishkek" });
}

export default async function ShowingsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const all = await showings();

  const now = new Date();
  const today = bishkekDay(now);
  const tomorrow = bishkekDay(new Date(now.getTime() + 86_400_000));

  const overdue = all.filter((s) => s.overdue);
  const ahead = all
    .filter((s) => s.status === "scheduled" && !s.overdue)
    .sort((a, b) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at));
  const past = all
    .filter((s) => s.status !== "scheduled")
    .sort((a, b) => +new Date(b.scheduled_at) - +new Date(a.scheduled_at));

  // Группировка по дням: экран дня, а не список записей.
  const days: { key: string; items: Showing[] }[] = [];
  for (const s of ahead) {
    const key = dayKey(s.on_day);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(s);
    else days.push({ key, items: [s] });
  }

  return (
    <div className="wrap">
      <h1>Показы</h1>
      <p className="lead">
        Показ живёт внутри подбора: назначают его в карточке клиента, а здесь
        он становится днём — куда ехать, к кому и когда. Исход записывает тот,
        кто показ проводил.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {overdue.length > 0 && (
        <section>
          <h2 className="alarm">
            Просрочено <span className="muted">({overdue.length})</span>
          </h2>
          <p className="muted">
            Время прошло, а исхода нет. Молчание о показе не значит, что он
            прошёл хорошо: собственник ждёт ответа, клиент тоже.
          </p>
          <div className="rows">
            {overdue.map((s) => (
              <ShowingCard key={s.id} s={s} clock={clock} overdue />
            ))}
          </div>
        </section>
      )}

      {days.length === 0 && overdue.length === 0 && (
        <p className="empty">
          Показов не назначено. Показ назначается из карточки клиента: откройте
          подбор и выберите время.
        </p>
      )}

      {days.map(({ key, items }) => (
        <section key={key}>
          <h2>
            {dayTitle(key, today, tomorrow)}{" "}
            <span className="muted">
              ({items.length} {plural(items.length, "показ", "показа", "показов")})
            </span>
          </h2>
          <div className="rows">
            {items.map((s) => (
              <ShowingCard key={s.id} s={s} clock={clock} />
            ))}
          </div>
        </section>
      ))}

      {past.length > 0 && (
        <section>
          <h2>
            История <span className="muted">({past.length})</span>
          </h2>
          <p className="muted">
            Из этого собирается отчёт собственнику: сколько раз объект
            показали, кому и с какой реакцией.
          </p>
          <div className="rows">
            {past.map((s) => (
              <article key={s.id} className="row">
                <div className="row-main">
                  <h3>
                    <a href={`/cabinet/objects/${s.object_id}`}>{s.address}</a>
                  </h3>
                  <p className="row-meta">
                    {s.client_name ?? "клиент"} ·{" "}
                    {s.i_lead ? "показывали вы" : `показывал ${s.agent_name ?? "—"}`}
                    {" · "}
                    {formatDateTime(s.scheduled_at)}
                  </p>
                  {s.client_reaction && <p className="note">{s.client_reaction}</p>}
                  {s.cancel_reason && <p className="muted">{s.cancel_reason}</p>}
                </div>
                <div className="row-state">
                  <span
                    className={`chip ${
                      s.status === "done" ? "ok" : s.status === "no_show" ? "danger" : ""
                    }`}
                  >
                    {SHOWING_LABEL[s.status] ?? s.status}
                  </span>
                  {s.outcome && (
                    <p className="muted">{OUTCOME_LABEL[s.outcome] ?? s.outcome}</p>
                  )}
                  <p className="muted">
                    {formatPrice(s.price, s.currency, s.deal_type as never)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
