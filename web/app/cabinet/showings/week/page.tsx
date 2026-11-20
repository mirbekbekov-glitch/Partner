import type { Metadata } from "next";
import { week, type Showing } from "../../../../lib/cabinet";
import { OUTCOME_LABEL, plural } from "../../../../lib/format";
import { gate } from "../../Gate";

export const metadata: Metadata = {
  title: "Календарь показов",
  robots: { index: false, follow: false },
};

const BISHKEK = "Asia/Bishkek";
const DAY = 86_400_000;

/** Дата в поясе агентства, строкой YYYY-MM-DD: ключ дня и значение ссылки. */
function dayKey(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: BISHKEK });
}

function clock(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString("ru-RU", {
    timeZone: BISHKEK,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Час показа по Бишкеку — по нему показ попадает в строку сетки. */
function hourOf(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return Number(
    date.toLocaleString("en-GB", { timeZone: BISHKEK, hour: "2-digit", hour12: false }),
  );
}

export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { w } = await searchParams;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(w ?? "") ? w : undefined;
  const data = await week(anchor);
  if (!data) return null;

  const monday = new Date(`${data.monday}T00:00:00Z`);
  const days = Array.from({ length: 7 }, (_, i) => new Date(+monday + i * DAY));
  const opens = Number(data.opens.slice(0, 2));
  const closes = Number(data.closes.slice(0, 2));
  const hours = Array.from({ length: closes - opens + 1 }, (_, i) => opens + i);

  const today = dayKey(new Date());
  const prev = dayKey(new Date(+monday - 7 * DAY));
  const next = dayKey(new Date(+monday + 7 * DAY));

  // Раскладка: день → час → показы. Показ, не попавший в сетку (история в
  // неурочный час), не теряется — он считается отдельно и назван внизу дня.
  const cells = new Map<string, Showing[]>();
  const outside = new Map<string, number>();
  for (const s of data.showings) {
    const key = dayKey(new Date(s.scheduled_at));
    const hour = hourOf(s.scheduled_at);
    if (hour < opens || hour > closes) {
      outside.set(key, (outside.get(key) ?? 0) + 1);
      continue;
    }
    const cell = `${key} ${hour}`;
    const list = cells.get(cell);
    if (list) list.push(s);
    else cells.set(cell, [s]);
  }

  const mine = data.showings.filter((s) => s.i_lead && s.status === "scheduled").length;
  const clashCount = data.clashPairs;

  return (
    <div className="wrap">
      <h1>Календарь показов</h1>
      <p className="lead">
        Неделя целиком: где час уже занят, где свободно и где к одной двери
        идут двое. Назначают показ в карточке клиента — отсюда видно, на какое
        время его назначать.
      </p>

      <nav className="views">
        <a href="/cabinet/showings">День</a>
        <span className="now">Неделя</span>
      </nav>

      <nav className="weeknav">
        <a className="btn" href={`/cabinet/showings/week?w=${prev}`}>← Прошлая</a>
        <strong>
          {days[0].toLocaleDateString("ru-RU", { timeZone: BISHKEK, day: "numeric", month: "long" })}
          {" — "}
          {days[6].toLocaleDateString("ru-RU", { timeZone: BISHKEK, day: "numeric", month: "long" })}
        </strong>
        <a className="btn" href="/cabinet/showings/week">Эта неделя</a>
        <a className="btn" href={`/cabinet/showings/week?w=${next}`}>Следующая →</a>
      </nav>

      <p className="muted">
        {mine === 0
          ? "На этой неделе у вас показов не назначено."
          : `Ваших назначенных показов на этой неделе: ${mine}. Блёклым — уже прошедшее и чужое.`}
        {clashCount > 0 && (
          <>
            {" "}
            <span className="act-err">
              {clashCount === 1
                ? "У одной двери на этой неделе окажутся две группы"
                : `У ${clashCount} ${plural(clashCount, "двери", "дверей", "дверей")} на этой неделе окажутся две группы`}
              : объект в один час показывают два агента. База это не запрещает —
              иногда так и договариваются, — но знать об этом надо заранее.
            </span>
          </>
        )}
      </p>

      <div className="calwrap">
        <div
          className="cal"
          style={{ gridTemplateRows: `auto repeat(${hours.length}, minmax(3.2rem, auto))` }}
        >
          <div className="cal-corner" />
          {days.map((d) => {
            const key = dayKey(d);
            return (
              <div key={key} className={key === today ? "cal-head today" : "cal-head"}>
                <strong>
                  {d.toLocaleDateString("ru-RU", { timeZone: BISHKEK, weekday: "short" })}
                </strong>
                <span>
                  {key === today
                    ? "сегодня"
                    : d.toLocaleDateString("ru-RU", { timeZone: BISHKEK, day: "numeric", month: "short" })}
                </span>
              </div>
            );
          })}

          {hours.map((hour) => (
            <Row
              key={hour}
              hour={hour}
              days={days}
              today={today}
              cells={cells}
              clashes={data.clashes}
            />
          ))}
        </div>
      </div>

      {outside.size > 0 && (
        <p className="muted">
          Вне сетки ({data.opens.slice(0, 5)}—{data.closes.slice(0, 5)}):{" "}
          {[...outside.entries()]
            .map(([key, n]) => `${key.slice(8, 10)}.${key.slice(5, 7)} — ${n}`)
            .join(", ")}
          . Это записанная история: назначить показ в такой час база не даст, а
          спрятать уже записанный — не вправе.
        </p>
      )}
    </div>
  );
}

function Row({
  hour,
  days,
  today,
  cells,
  clashes,
}: {
  hour: number;
  days: Date[];
  today: string;
  cells: Map<string, Showing[]>;
  clashes: Record<string, string>;
}) {
  return (
    <>
      <div className="cal-hour">{String(hour).padStart(2, "0")}:00</div>
      {days.map((d) => {
        const key = dayKey(d);
        const items = cells.get(`${key} ${hour}`) ?? [];
        return (
          <div key={key} className={key === today ? "cal-cell today" : "cal-cell"}>
            {items.map((s) => {
              const clash = clashes[s.id];
              const classes = [
                "slot",
                s.i_lead ? "mine" : "theirs",
                s.status !== "scheduled" ? "past" : "",
                clash ? "clash" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <a key={s.id} className={classes} href={`/cabinet/objects/${s.object_id}`}>
                  <b>{clock(s.scheduled_at)}</b> {s.address}
                  <em>
                    {s.i_lead ? (s.client_name ?? "клиент") : (s.agent_name ?? "коллега")}
                    {s.status === "done" && s.outcome
                      ? ` · ${OUTCOME_LABEL[s.outcome] ?? s.outcome}`
                      : ""}
                    {s.status === "cancelled" ? " · отменён" : ""}
                    {s.status === "no_show" ? " · не пришёл" : ""}
                    {clash ? ` · здесь же ${clash}` : ""}
                  </em>
                </a>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
