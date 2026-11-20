import type { Metadata } from "next";
import { requirements } from "../../../lib/cabinet";
import { formatPhone, formatDate, plural } from "../../../lib/format";
import { gate } from "../Gate";

export const metadata: Metadata = {
  title: "Клиенты",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, string> = {
  new: "новая",
  qualified: "в работе",
  in_showings: "на показах",
  in_deal: "в сделке",
  closed: "закрыта",
  lost: "потеряна",
};

function budget(min: string | null, max: string | null, currency = "$"): string {
  const money = (v: string) => Number(v).toLocaleString("ru-RU");
  if (min && max) return `${money(min)} – ${money(max)} ${currency}`;
  if (max) return `до ${money(max)} ${currency}`;
  if (min) return `от ${money(min)} ${currency}`;
  return "бюджет не назван";
}

export default async function RequirementsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const all = await requirements();
  const mine = all.filter((r) => r.is_mine);
  const others = all.filter((r) => !r.is_mine);

  return (
    <div className="wrap">
      <div className="head-row">
        <h1>Клиенты</h1>
        <a className="btn primary" href="/cabinet/requirements/new">Новый клиент</a>
      </div>

      <p className="lead">
        Потребность — это то, что клиент ищет. Подбор по ней ведёт тот агент,
        который её завёл: доля агента покупателя считается именно по нему, и
        передавать клиента надо явно, а не подбором мимо.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {mine.length === 0 && (
        <p className="empty">
          У вас нет заведённых клиентов. Потребность заводится из обращения или
          вручную.
        </p>
      )}

      <RequirementRows items={mine} />

      {others.length > 0 && (
        <>
          <h2>Клиенты коллег <span className="muted">({others.length})</span></h2>
          <p className="muted">
            Видны, чтобы знать, что уже ищут в агентстве. Подбор по ним база не
            даст — это инвариант 20, а не настройка экрана.
          </p>
          <RequirementRows items={others} muted />
        </>
      )}
    </div>
  );
}

function RequirementRows({
  items,
  muted,
}: {
  items: Awaited<ReturnType<typeof requirements>>;
  muted?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="rows">
      {items.map((r) => (
        <article key={r.id} className={r.status === "new" ? "row alarm" : "row"}>
          <div className="row-main">
            <h3>
              {muted ? (
                r.client_name ?? "Без имени"
              ) : (
                <a href={`/cabinet/requirements/${r.id}`}>{r.client_name ?? "Без имени"}</a>
              )}
            </h3>
            {r.client_phone && !muted && (
              <p className="phone">{formatPhone(r.client_phone)}</p>
            )}
            <p className="row-meta">
              {r.deal_type === "sale" ? "покупка" : "аренда"} ·{" "}
              {budget(r.budget_min, r.budget_max)}
              {r.zones.length > 0 ? ` · ${r.zones.join(", ")}` : ""}
              {r.rooms.length > 0 ? ` · ${r.rooms.join(" или ")} комн.` : ""}
            </p>
            {r.requirements_text && <p className="note">{r.requirements_text}</p>}
            <p className="muted">
              {muted && r.agent_name ? `ведёт ${r.agent_name} · ` : ""}
              {r.matches_total} {plural(r.matches_total, "предложение", "предложения", "предложений")}
              {" · "}
              {r.showings_total} {plural(r.showings_total, "показ", "показа", "показов")}
              {r.deadline ? ` · срок до ${formatDate(r.deadline)}` : ""}
            </p>
          </div>
          <div className="row-state">
            <span className={`chip ${r.status}`}>{STATUS[r.status] ?? r.status}</span>
          </div>
          {!muted && (
            <div className="row-acts">
              <a className="btn" href={`/cabinet/requirements/${r.id}`}>Подбор</a>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
