import type { Metadata } from "next";
import { candidates } from "../../../lib/cabinet";
import { formatPrice, KIND_LABEL, formatDate, formatArea, formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { claimCandidate, rejectCandidate, releaseCandidate } from "../actions";

export const metadata: Metadata = {
  title: "Объявления с площадок",
  robots: { index: false, follow: false },
};

// Площадка называется house.kg, а не house_kg: имя значения перечисления —
// это имя в базе, и показывать его человеку незачем.
const SOURCE: Record<string, string> = {
  house_kg: "house.kg",
  lalafo: "lalafo.kg",
  manual: "внесено вручную",
};

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;

  const items = await candidates();
  const mine = items.filter((c) => c.claimed_by_me);
  const free = items.filter((c) => !c.claimed_by_me && c.status === "new");
  const taken = items.filter((c) => !c.claimed_by_me && c.status === "in_work");

  return (
    <div className="wrap">
      <h1>Объявления с площадок</h1>
      <p className="lead">
        Объявления собственников с house.kg. Взятое закрепляется за одним
        агентом на срок — пока он закреплён, другой его не возьмёт. Телефон из
        объявления виден только взявшему.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      <h2>В работе у вас <span className="muted">({mine.length})</span></h2>
      {mine.length === 0 && (
        <p className="empty">Вы пока ничего не взяли из пула.</p>
      )}
      <div className="rows">
        {mine.map((c) => (
          <article key={c.id} className="row">
            <Candidate item={c} />
            <div className="row-acts">
              {c.phone ? (
                <p className="phone">{formatPhone(c.phone)}</p>
              ) : (
                <p className="muted small">
                  Телефона нет: на house.kg он за кнопкой, которая ходит в
                  закрытый <code>/api/</code>. Звонить через сайт площадки.
                </p>
              )}
              <a className="btn primary" href={`/cabinet/objects/new?candidate=${c.id}`}>
                Завести объект
              </a>
              <ActionForm action={releaseCandidate} label="Вернуть в пул">
                <input type="hidden" name="candidate_id" value={c.id} />
              </ActionForm>
              <details className="fold">
                <summary>Не подходит</summary>
                <ActionForm action={rejectCandidate} label="Отказаться">
                  <input type="hidden" name="candidate_id" value={c.id} />
                  <input name="reason" placeholder="Причина — обязательна" required />
                </ActionForm>
              </details>
            </div>
          </article>
        ))}
      </div>

      <h2>Свободные <span className="muted">({free.length})</span></h2>
      <div className="rows">
        {free.map((c) => (
          <article key={c.id} className="row">
            <Candidate item={c} />
            <div className="row-acts">
              <ActionForm action={claimCandidate} label="Взять в работу">
                <input type="hidden" name="candidate_id" value={c.id} />
                <label>
                  Закрепить на дней
                  <input name="days" type="number" min={1} max={14} defaultValue={3} />
                </label>
              </ActionForm>
            </div>
          </article>
        ))}
      </div>

      {taken.length > 0 && (
        <>
          <h2>В работе у коллег <span className="muted">({taken.length})</span></h2>
          <p className="muted">
            Перехватить нельзя: закрепление снимает срок или сам агент.
          </p>
          <div className="rows compact">
            {taken.map((c) => (
              <article key={c.id} className="row">
                <Candidate item={c} />
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Candidate({ item: c }: { item: Awaited<ReturnType<typeof candidates>>[number] }) {
  return (
    <div className="row-main">
      <h3>
        {c.url ? (
          <a className="ext" href={c.url} target="_blank" rel="noreferrer noopener">
            {c.title ?? c.address ?? "Объявление"} ↗
          </a>
        ) : (
          (c.title ?? c.address ?? "Объявление")
        )}
      </h3>
      <p className="row-meta">
        {c.kind ? (KIND_LABEL[c.kind as keyof typeof KIND_LABEL] ?? c.kind) : "вид не определён"}
        {c.rooms ? `, ${c.rooms} комн.` : ""}
        {c.area ? `, ${formatArea(c.area)}` : ""}
        {c.zone ? ` · ${c.zone}` : ""}
      </p>
      {c.price && (
        <p className="row-price">
          {formatPrice(c.price, c.currency, (c.deal_type ?? "sale") as never)}
        </p>
      )}
      <p className="muted">
        {SOURCE[c.source] ?? c.source} ·{" "}
        {c.author === "owner" ? "собственник" : c.author === "agent" ? "посредник" : "неизвестно"}
        {c.claimed_until ? ` · закреплено до ${formatDate(c.claimed_until)}` : ""}
      </p>
    </div>
  );
}
