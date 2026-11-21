import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirementDetail } from "../../../../lib/cabinet";
import {
  formatPrice, formatArea, formatDate, formatDateTime, formatPhone,
  freshness, KIND_LABEL, OUTCOME_LABEL, plural, PUBLICATION_LABEL, SHOWING_LABEL,
} from "../../../../lib/format";
import { gate } from "../../Gate";
import { ActionForm } from "../../ActionForm";
import { Transfer } from "../../Transfer";
import { transferTargets } from "../../../../lib/cabinet";
import { transferRequirement } from "../../actions";
import {
  cancelShowing, completeShowing, markNoShow, proposeObject, scheduleShowing, startDeal,
} from "../../actions";

export const metadata: Metadata = {
  title: "Подбор",
  robots: { index: false, follow: false },
};

const MATCH_STATUS: Record<string, string> = {
  proposed: "предложен",
  interested: "заинтересовал",
  showing_scheduled: "показ назначен",
  showing_done: "показ прошёл",
  bargaining: "торг",
  rejected: "отказ",
  in_deal: "в сделке",
};

const OUTCOME: Record<string, string> = {
  interested: "понравилось",
  wants_bargain: "хочет торговаться",
  thinking: "думает",
  rejected: "не подошло",
};

export default async function RequirementPage({
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
  const data = await requirementDetail(id);
  if (!data) notFound();

  const targets = data.requirement.is_mine ? await transferTargets() : [];

  const r = data.requirement;
  const fresh = data.candidates.filter((c) => !c.already_proposed);
  const exact = fresh.filter((c) => c.fit === "подходит");
  const nearly = fresh.filter((c) => c.fit !== "подходит");

  return (
    <div className="wrap">
      <p className="back"><a href="/cabinet/requirements">← к клиентам</a></p>
      <h1>{r.client_name ?? "Без имени"}</h1>
      {note && <p className="ok-banner">{note}</p>}

      <p className="row-meta">
        {r.deal_type === "sale" ? "покупка" : "аренда"}
        {r.budget_min || r.budget_max
          ? ` · ${r.budget_min ? Number(r.budget_min).toLocaleString("ru-RU") : "0"} – ${
              r.budget_max ? Number(r.budget_max).toLocaleString("ru-RU") : "без потолка"
            }`
          : " · бюджет не назван"}
        {r.zones.length > 0 ? ` · ${r.zones.join(", ")}` : " · любой район"}
        {r.rooms.length > 0 ? ` · ${r.rooms.join(" или ")} комн.` : ""}
        {r.deadline ? ` · срок до ${formatDate(r.deadline)}` : ""}
      </p>
      {r.client_phone && <p className="phone">{formatPhone(r.client_phone)}</p>}
      {r.is_mine && (
        <>
          <p><a className="btn" href={`/cabinet/requirements/${r.id}/edit`}>Править условия</a></p>
          <Transfer
            action={transferRequirement}
            what="клиента"
            hidden={{ requirement_id: r.id }}
            targets={targets}
            note="Подборы в работе перейдут вместе с клиентом, и вести его будете уже не вы. Подборы, по которым сделка уже закрыта, останутся за вами — это история."
          />
        </>
      )}
      {r.requirements_text && <p className="note">{r.requirements_text}</p>}

      {!r.is_mine && (
        <p className="warn-banner">
          Этого клиента ведёт {r.agent_name ?? "другой агент"}. Подбор по чужой
          потребности база не даст: доля агента покупателя считается по тому,
          кто её ведёт.
        </p>
      )}

      {/* ---- предложенное ------------------------------------------------ */}
      <section>
        <h2>Предложено <span className="muted">({data.proposed.length})</span></h2>
        {data.proposed.length === 0 ? (
          <p className="empty">Клиенту пока ничего не предложено.</p>
        ) : (
          <div className="rows">
            {data.proposed.map((m) => {
              const showing = data.showings.find(
                (s) => s.match_id === m.match_id && s.status === "scheduled",
              );
              return (
                <article key={m.match_id} className="row">
                  <div className="row-main">
                    <h3><a href={`/cabinet/objects/${m.object_id}`}>{m.address}</a></h3>
                    <p className="row-price">
                      {formatPrice(m.price, m.currency, r.deal_type as never)}
                    </p>
                    {m.commission_total && (
                      <p className="muted">
                        комиссия {Number(m.commission_total).toLocaleString("ru-RU")}
                        {m.closing_share
                          ? `, ваша доля ${Number(m.closing_share).toLocaleString("ru-RU")}`
                          : ""}{" "}
                        — пока индикативно, до закрытия сделки
                      </p>
                    )}
                    {m.rejection_reason && <p className="act-err">{m.rejection_reason}</p>}
                  </div>

                  <div className="row-state">
                    <span className={`chip ${m.match_status}`}>
                      {MATCH_STATUS[m.match_status] ?? m.match_status}
                    </span>
                    {showing && (
                      <p className="muted">показ {formatDateTime(showing.scheduled_at)}</p>
                    )}
                    {(() => {
                      // Сколько раз этот объект уже показывали этому клиенту и
                      // чем кончился последний раз. Второй показ того же
                      // объекта — сильный сигнал, и терять его нельзя.
                      const history = data.showings.filter(
                        (h) => h.match_id === m.match_id && h.status !== "scheduled",
                      );
                      if (history.length === 0) return null;
                      const last = history[0];
                      return (
                        <p className="muted">
                          показов: {history.length}
                          {last.outcome ? `, последний — ${OUTCOME_LABEL[last.outcome] ?? last.outcome}` : ""}
                          {last.status === "no_show" ? ", клиент не пришёл" : ""}
                        </p>
                      );
                    })()}
                  </div>

                  {r.is_mine && (
                    <div className="row-acts">
                      {m.deal_id ? (
                        <a className="btn" href={`/cabinet/deals/${m.deal_id}`}>
                          Сделка
                        </a>
                      ) : (
                        <ActionForm action={startDeal} label="Завести сделку">
                          <input type="hidden" name="match_id" value={m.match_id} />
                          <input type="hidden" name="requirement_id" value={r.id} />
                        </ActionForm>
                      )}
                      {showing ? (
                        <>
                          <details className="fold">
                            <summary>Показ прошёл</summary>
                            <ActionForm action={completeShowing} label="Закрыть показ">
                              <input type="hidden" name="requirement_id" value={r.id} />
                              <input type="hidden" name="showing_id" value={showing.id} />
                              <label>
                                Как прошло
                                <select name="outcome" defaultValue="thinking">
                                  <option value="interested">понравилось</option>
                                  <option value="wants_bargain">хочет торговаться</option>
                                  <option value="thinking">думает</option>
                                  <option value="rejected">не подошло</option>
                                </select>
                              </label>
                              <input name="reaction" placeholder="Слова клиента" />
                            </ActionForm>
                          </details>
                          <details className="fold">
                            <summary>Не пришёл</summary>
                            <ActionForm action={markNoShow} label="Клиент не пришёл">
                              <input type="hidden" name="requirement_id" value={r.id} />
                              <input type="hidden" name="showing_id" value={showing.id} />
                              <input name="note" placeholder="Что известно" />
                            </ActionForm>
                          </details>
                          <details className="fold">
                            <summary>Отменить показ</summary>
                            <ActionForm action={cancelShowing} label="Отменить" danger>
                              <input type="hidden" name="requirement_id" value={r.id} />
                              <input type="hidden" name="showing_id" value={showing.id} />
                              <input name="reason" placeholder="Причина" required />
                            </ActionForm>
                          </details>
                        </>
                      ) : (
                        <details className="fold">
                          <summary>Назначить показ</summary>
                          <ActionForm action={scheduleShowing} label="Назначить">
                            <input type="hidden" name="requirement_id" value={r.id} />
                            <input type="hidden" name="match_id" value={m.match_id} />
                            <input type="datetime-local" name="at" required />
                            <input name="note" placeholder="Заметка" />
                          </ActionForm>
                        </details>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- подбор ------------------------------------------------------ */}
      <section>
        <h2>
          Подходит <span className="muted">({exact.length})</span>
        </h2>
        <p className="muted">
          Объекты с действующим договором, подходящие по типу сделки, бюджету,
          району и числу комнат. Сначала те, что подтверждали недавно:
          несвежее объявление тратит время клиента.
        </p>
        <Candidates items={exact} requirementId={r.id} canPropose={r.is_mine} />

        {nearly.length > 0 && (
          <>
            <h2>
              Чуть дороже <span className="muted">({nearly.length})</span>
            </h2>
            <p className="muted">
              Выше потолка бюджета не больше чем на десятую часть. Показывать
              такое или нет — решение агента, а не базы.
            </p>
            <Candidates items={nearly} requirementId={r.id} canPropose={r.is_mine} />
          </>
        )}

        {fresh.length === 0 && (
          <p className="empty">
            Подходящего нет. Либо условия клиента слишком узкие, либо в
            агентстве нет таких объектов с действующим договором.
          </p>
        )}
      </section>

      {/* ---- показы ------------------------------------------------------ */}
      {data.showings.length > 0 && (
        <section>
          <h2>
            Показы <span className="muted">
              ({data.showings.length}{" "}
              {plural(data.showings.length, "показ", "показа", "показов")})
            </span>
          </h2>
          <ul className="plain">
            {data.showings.map((s) => (
              <li key={s.id}>
                {formatDateTime(s.scheduled_at)} · {s.address} ·{" "}
                <span className="chip">{SHOWING_LABEL[s.status] ?? s.status}</span>
                {s.outcome ? ` · ${OUTCOME[s.outcome] ?? s.outcome}` : ""}
                {s.client_reaction ? ` — «${s.client_reaction}»` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Candidates({
  items,
  requirementId,
  canPropose,
}: {
  items: Awaited<ReturnType<typeof requirementDetail>> extends null
    ? never
    : NonNullable<Awaited<ReturnType<typeof requirementDetail>>>["candidates"];
  requirementId: string;
  canPropose: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="rows">
      {items.map((c) => (
        <article key={c.object_id} className="row">
          <div className="row-main">
            <h3><a href={`/cabinet/objects/${c.object_id}`}>{c.address}</a></h3>
            <p className="row-meta">
              {KIND_LABEL[c.kind as keyof typeof KIND_LABEL] ?? c.kind}
              {c.rooms ? `, ${c.rooms} комн.` : ""}
              {c.area ? `, ${formatArea(c.area)}` : ""}
              {c.zone ? ` · ${c.zone}` : ""}
            </p>
            <p className="row-price">
              {formatPrice(c.price, c.currency, "sale" as never)}
            </p>
            <p className="muted">
              {freshness(c.actual_at).label}
              {c.photos_count === 0 ? " · без фотографий" : ` · ${c.photos_count} фото`}
              {c.is_mine ? " · ваш объект" : c.listing_agent ? ` · ведёт ${c.listing_agent}` : ""}
            </p>
          </div>

          <div className="row-state">
            {c.publication_state !== "published" && (
              <span className="chip warn">
                {PUBLICATION_LABEL[c.publication_state] ?? c.publication_state}
              </span>
            )}
            {c.fit !== "подходит" && <span className="chip warn">{c.fit}</span>}
          </div>

          {canPropose && (
            <div className="row-acts">
              <ActionForm action={proposeObject} label="Предложить клиенту">
                <input type="hidden" name="requirement_id" value={requirementId} />
                <input type="hidden" name="object_id" value={c.object_id} />
              </ActionForm>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
