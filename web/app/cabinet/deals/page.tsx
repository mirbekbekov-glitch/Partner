import type { Metadata } from "next";
import { deals } from "../../../lib/cabinet";
import { formatDate, formatPrice } from "../../../lib/format";
import { gate } from "../Gate";

export const metadata: Metadata = {
  title: "Сделки",
  robots: { index: false, follow: false },
};

export const DEAL_STATUS: Record<string, string> = {
  deposit: "задаток",
  contract: "договор",
  closed: "закрыта",
  failed: "сорвана",
};

/** Сумма комиссии с валютой: рядом стоит цена, и число без знака двусмысленно. */
function money(value: string | null, currency: string): string | null {
  if (value === null) return null;
  const amount = Number(value).toLocaleString("ru-RU");
  if (currency === "USD") return "$" + amount;
  return amount + " " + (currency === "KGS" ? "с" : currency);
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const all = await deals();
  const mine = all.filter((d) => d.i_am_listing || d.i_am_closing);
  const others = all.filter((d) => !(d.i_am_listing || d.i_am_closing));

  const earned = mine
    .filter((d) => d.status === "closed")
    .reduce((sum, d) => sum + Number(d.my_share ?? 0), 0);

  return (
    <div className="wrap">
      <h1>Сделки</h1>
      <p className="lead">
        Сделка рождается из подбора и закрывается один раз. До закрытия суммы
        индикативны — считаются от цены объекта; после закрытия считаются от
        финальной цены и больше не меняются.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {earned > 0 && (
        <p className="ok-banner">
          Закрыто сделок: {mine.filter((d) => d.status === "closed").length}, ваша
          доля по ним {earned.toLocaleString("ru-RU")}.
        </p>
      )}

      {mine.length === 0 && (
        <p className="empty">
          У вас нет сделок. Сделка заводится из подбора, когда клиент
          договорился с собственником.
        </p>
      )}

      <DealRows items={mine} />

      {others.length > 0 && (
        <>
          <h2>Сделки коллег <span className="muted">({others.length})</span></h2>
          <p className="muted">
            Видны для прозрачности внутри агентства. Трогать их база не даст:
            сделку ведут её участники.
          </p>
          <DealRows items={others} muted />
        </>
      )}
    </div>
  );
}

function DealRows({
  items,
  muted,
}: {
  items: Awaited<ReturnType<typeof deals>>;
  muted?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="rows">
      {items.map((d) => (
        <article key={d.deal_id} className={d.status === "failed" ? "row" : "row"}>
          <div className="row-main">
            <h3>
              {muted ? d.address : <a href={`/cabinet/deals/${d.deal_id}`}>{d.address}</a>}
            </h3>
            <p className="row-meta">
              {d.client_name ?? "клиент"} ·{" "}
              {d.i_am_listing ? "вы листинг-агент" : `листинг ${d.listing_agent_name ?? "—"}`}
              {" · "}
              {d.i_am_closing ? "вы агент покупателя" : `покупатель ${d.closing_agent_name ?? "—"}`}
            </p>
            <p className="row-price">
              {d.status === "closed" && d.final_price
                ? formatPrice(d.final_price, d.currency, d.deal_type as never)
                : `${formatPrice(d.asking_price, d.currency, d.deal_type as never)} — цена объекта`}
            </p>
            {d.failure_reason && <p className="act-err">{d.failure_reason}</p>}
          </div>

          <div className="row-state">
            <span className={`chip ${d.status === "closed" ? "ok" : d.status === "failed" ? "danger" : "warn"}`}>
              {DEAL_STATUS[d.status] ?? d.status}
            </span>
            {d.status === "closed" ? (
              <p className="muted">
                комиссия {money(d.commission_total, d.currency)}
                {d.my_share ? `, ваша доля ${money(d.my_share, d.currency)}` : ""}
                {d.closed_at ? ` · ${formatDate(d.closed_at)}` : ""}
              </p>
            ) : d.status === "failed" ? (
              <p className="muted">комиссии нет</p>
            ) : (
              <p className="muted">
                ожидается {money(d.indicative_total, d.currency)}
                {d.indicative_my_share ? `, ваша доля ${money(d.indicative_my_share, d.currency)}` : ""}{" "}
                — индикативно
              </p>
            )}
          </div>

          {!muted && (
            <div className="row-acts">
              <a className="btn" href={`/cabinet/deals/${d.deal_id}`}>Открыть</a>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
