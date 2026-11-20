import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dealDetail } from "../../../../lib/cabinet";
import { formatDate, formatDateTime, formatPrice, KIND_LABEL } from "../../../../lib/format";
import { gate } from "../../Gate";
import { ActionForm } from "../../ActionForm";
import { closeDeal, failDeal, setDealStage } from "../../actions";
import { DealStages } from "../../DealStages";
import { DEAL_STATUS } from "../page";

export const metadata: Metadata = {
  title: "Сделка",
  robots: { index: false, follow: false },
};

/**
 * Сумма комиссии. С валютой: рядом стоит цена в долларах, и «1 900» без знака
 * читается как неизвестно что. Комиссия всегда в валюте сделки — она от неё и
 * считается.
 */
function money(value: string | null, currency: string): string {
  if (value === null) return "—";
  const amount = Number(value).toLocaleString("ru-RU");
  if (currency === "USD") return "$" + amount;
  return amount + " " + (currency === "KGS" ? "с" : currency);
}

export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { id } = await params;
  const { note } = await searchParams;
  const d = await dealDetail(id);
  if (!d) notFound();

  const mine = d.i_am_listing || d.i_am_closing;
  const open = d.status !== "closed" && d.status !== "failed";

  return (
    <div className="wrap narrow">
      <p className="back"><a href="/cabinet/deals">← к сделкам</a></p>
      <h1>{d.address}</h1>
      {note && <p className="ok-banner">{note}</p>}

      <p>
        <span className={`chip ${d.status === "closed" ? "ok" : d.status === "failed" ? "danger" : "warn"}`}>
          {DEAL_STATUS[d.status] ?? d.status}
        </span>
        <span className="chip">
          {KIND_LABEL[d.kind as keyof typeof KIND_LABEL] ?? d.kind}
        </span>
        <span className="chip">
          {d.mandate_kind === "exclusive" ? "эксклюзив" : "неэксклюзив"}
        </span>
      </p>

      <section className="card">
        <dl className="facts">
          <dt>Клиент</dt>
          <dd>{d.client_name ?? "—"}</dd>
          <dt>Объект</dt>
          <dd><a href={`/cabinet/objects/${d.object_id}`}>{d.address}</a></dd>
          <dt>Листинг-агент</dt>
          <dd>{d.listing_agent_name ?? "—"}{d.i_am_listing ? " (вы)" : ""}</dd>
          <dt>Агент покупателя</dt>
          <dd>{d.closing_agent_name ?? "—"}{d.i_am_closing ? " (вы)" : ""}</dd>
          <dt>Заведена</dt>
          <dd>{formatDateTime(d.created_at)}</dd>
          {d.closed_at && (
            <>
              <dt>Закрыта</dt>
              <dd>{formatDate(d.closed_at)}</dd>
            </>
          )}
        </dl>
      </section>

      {open && (
        <DealStages
          action={setDealStage}
          dealId={d.deal_id}
          current={d.status}
          stageSince={d.stage_since}
          daysInStage={d.days_in_stage}
          budgetDays={d.stage_budget_days}
          canMove={mine}
        />
      )}

      <section className="card">
        <h2>Деньги</h2>
        {d.status === "closed" ? (
          <>
            <dl className="facts">
              <dt>Финальная цена</dt>
              <dd>{formatPrice(d.final_price ?? "0", d.currency, d.deal_type as never)}</dd>
              <dt>Комиссия</dt>
              <dd>{money(d.commission_total, d.currency)}</dd>
              <dt>Доля листинг-агента</dt>
              <dd>{money(d.listing_share, d.currency)}</dd>
              <dt>Доля агента покупателя</dt>
              <dd>{money(d.closing_share, d.currency)}</dd>
              {d.my_share && (
                <>
                  <dt>Ваша доля</dt>
                  <dd><strong>{money(d.my_share, d.currency)}</strong></dd>
                </>
              )}
            </dl>
            <p className="hint">
              Суммы зафиксированы при закрытии и больше не меняются — ни ценой,
              ни ставкой договора, ни правкой. Если сумма записана неверно, это
              исправляется новой сделкой, а не правкой этой.
            </p>
          </>
        ) : d.status === "failed" ? (
          <>
            <p>Сделка сорвана, комиссии нет.</p>
            {d.failure_reason && <p className="note">{d.failure_reason}</p>}
            <p className="hint">
              Клиент и подбор вернулись в работу: сделка сорвалась, клиент
              остался.
            </p>
          </>
        ) : (
          <>
            <dl className="facts">
              <dt>Цена объекта</dt>
              <dd>{formatPrice(d.asking_price, d.currency, d.deal_type as never)}</dd>
              <dt>Комиссия ожидается</dt>
              <dd>{money(d.indicative_total, d.currency)}</dd>
              {d.indicative_my_share && (
                <>
                  <dt>Ваша доля ожидается</dt>
                  <dd>{money(d.indicative_my_share, d.currency)}</dd>
                </>
              )}
              {d.closing_share_ratio && (
                <>
                  <dt>Ставка агента покупателя</dt>
                  <dd>{(Number(d.closing_share_ratio) * 100).toFixed(0)}% — назначена владельцем договора</dd>
                </>
              )}
            </dl>
            <p className="hint">
              Это оценка от цены объекта. Окончательная сумма считается от
              финальной цены при закрытии.
            </p>
          </>
        )}
      </section>

      {mine && open && (
        <section className="card">
          <h2>Закрыть сделку</h2>
          <p>
            Закрыть можно один раз. После этого комиссия зафиксирована, мандат
            закрывается, а объект уходит из каталога.
          </p>
          <ActionForm action={closeDeal} label="Закрыть сделку"
                      confirm="Закрыть сделку? Суммы зафиксируются и изменить их будет нельзя.">
            <input type="hidden" name="deal_id" value={d.deal_id} />
            <label>
              Финальная цена
              <input name="final_price" inputMode="decimal"
                     defaultValue={d.asking_price} required />
            </label>
          </ActionForm>

          <h2>Или сорвать</h2>
          <details className="fold">
            <summary>Сделка сорвалась</summary>
            <ActionForm action={failDeal} label="Зафиксировать срыв" danger>
              <input type="hidden" name="deal_id" value={d.deal_id} />
              <input name="reason" placeholder="Причина — обязательна" required />
            </ActionForm>
          </details>
        </section>
      )}

      {!mine && (
        <p className="warn">
          Это сделка других агентов. Видна для прозрачности внутри агентства,
          но трогать её база не даст: сделку ведут её участники.
        </p>
      )}
    </div>
  );
}
