import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CHANNEL_LABEL,
  OUTCOME_LABEL,
  STATE_LABEL,
  type ShowingOutcome,
  fetchOwnerReport,
} from "@/lib/report";
import {
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatFloor,
  formatPrice,
  formatRooms,
  freshness,
  plural,
} from "@/lib/format";

type Props = { params: Promise<{ token: string }> };

// Страница по секретной ссылке. В индекс ей нельзя ни при каких условиях.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "Отчёт по объекту",
};

const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function formatDate(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
}

export default async function OwnerReportPage({ params }: Props) {
  const { token } = await params;
  const report = await fetchOwnerReport(token);
  if (!report) notFound();

  const { object, channels, showings, interest, price_changes } = report;
  const fresh = freshness(object.actual_at);
  const live = channels.filter((c) => c.in_feed);
  const outcomes = Object.entries(showings.outcomes) as Array<
    [ShowingOutcome, number]
  >;
  const params_ = [
    formatRooms(object.rooms),
    formatArea(object.area),
    formatFloor(object.floor, object.floors_total),
  ].filter((x): x is string => x !== null);

  return (
    <div className="wrap report">
      <p className="report-kicker">Отчёт о работе по вашему объекту</p>
      <h1>
        {KIND_LABEL[object.kind]}, {object.address}
      </h1>
      <p className="lede">
        {DEAL_LABEL[object.deal_type]}
        {object.zone ? ` · ${object.zone}` : ""}
        {params_.length ? ` · ${params_.join(" · ")}` : ""}
      </p>

      <div className="tiles">
        <div className="tile">
          <span className="k">Цена в объявлении</span>
          <span className="v">
            {formatPrice(object.price, object.currency, object.deal_type)}
          </span>
          <span className="n">
            {price_changes.count > 0
              ? `Менялась ${price_changes.count} ${plural(price_changes.count, "раз", "раза", "раз")}, последний раз ${formatDate(price_changes.last_at)}`
              : "С начала работы не менялась"}
          </span>
        </div>

        <div className="tile">
          <span className="k">Состоявшихся показов</span>
          <span className="v">{showings.done}</span>
          <span className="n">
            {showings.scheduled > 0 && `Назначено ещё ${showings.scheduled}. `}
            {showings.last_done_at
              ? `Последний ${formatDate(showings.last_done_at)}`
              : "Показов пока не было"}
          </span>
        </div>

        <div className="tile">
          <span className="k">Клиентов рассматривали</span>
          <span className="v">{interest.matches}</span>
          <span className="n">
            {interest.rejected > 0
              ? `${interest.rejected} отказались после знакомства с объектом`
              : "Отказов пока нет"}
          </span>
        </div>

        <div className="tile">
          <span className="k">Состояние</span>
          <span className="v small">{STATE_LABEL[object.publication_state]}</span>
          <span className={`n fresh-${fresh.tone}`}>{fresh.label}</span>
        </div>
      </div>

      <section className="report-block">
        <h2>Куда отдаётся объект</h2>
        {live.length === 0 ? (
          <p className="muted">
            Объект пока не отдаётся ни на одну площадку.
          </p>
        ) : (
          <ul className="channels">
            {live.map((c) => (
              <li key={c.channel}>
                <span className="ch-name">
                  {CHANNEL_LABEL[c.channel] ?? c.channel}
                </span>
                <span className={c.has_error ? "fresh-stale" : "fresh-fresh"}>
                  {c.has_error ? "ошибка выгрузки, агент разбирается" : "отдаём"}
                </span>
                <span className="muted">
                  {c.fetched_at
                    ? `площадка забирала ${formatDate(c.fetched_at)}`
                    : "площадка за выгрузкой ещё не приходила"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="report-block">
        <h2>Что говорят после показов</h2>
        {showings.done === 0 ? (
          <p className="muted">
            Показов ещё не было, поэтому и реакций пока нет.
          </p>
        ) : outcomes.length === 0 ? (
          <p className="muted">Реакции по показам не записаны.</p>
        ) : (
          <ul className="outcomes">
            {outcomes.map(([outcome, count]) => (
              <li key={outcome}>
                <strong>{count}</strong> {OUTCOME_LABEL[outcome] ?? outcome}
              </li>
            ))}
          </ul>
        )}
        {showings.cancelled > 0 && (
          <p className="muted">
            Ещё {showings.cancelled}{" "}
            {plural(showings.cancelled, "показ", "показа", "показов")} были
            отменены или клиент не пришёл.
          </p>
        )}
      </section>

      <p className="note report-note">
        Эта страница открыта по личной ссылке и в поиске не показывается.
        Имена и телефоны клиентов в отчёт не попадают — мы не передаём их
        никому, включая собственника, пока не началась сделка. Если что-то в
        отчёте выглядит неверно, скажите агенту, который ведёт объект.
      </p>
    </div>
  );
}
