import type { Metadata } from "next";
import { inquiries } from "../../../lib/cabinet";
import { formatPhone } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { qualifyInquiry, rejectInquiry } from "../actions";

export const metadata: Metadata = {
  title: "Обращения",
  robots: { index: false, follow: false },
};

// Намерение в схеме ровно трёх видов: спрос, предложение и «пока не ясно».
// Третье не лишнее: по звонку часто не понять, человек ищет или предлагает,
// и выдумывать за него нельзя.
const INTENT: Record<string, string> = {
  demand: "ищет",
  supply: "предлагает",
  unknown: "намерение не ясно",
};

const CHANNEL: Record<string, string> = {
  phone: "звонок",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  site: "сайт",
  lalafo: "lalafo",
  house_kg: "house.kg",
  walk_in: "пришёл в офис",
  referral: "по рекомендации",
  other: "другое",
};

const STATUS: Record<string, string> = {
  new: "новое",
  qualified: "в работе",
  converted: "закрыто исходом",
  rejected: "отказ",
  spam: "спам",
};

function waited(hours: number): string {
  if (hours < 1) return "только что";
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн.`;
}

export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;

  const items = await inquiries();
  const open = items.filter((i) => i.status === "new" || i.status === "qualified");
  const closed = items.filter((i) => !(i.status === "new" || i.status === "qualified"));

  return (
    <div className="wrap">
      <h1>Обращения</h1>
      <p className="lead">
        Очередь, а не журнал: сверху то, что ждёт дольше всех. Обращение
        закрывается ровно одним исходом — потребностью клиента или объектом, —
        и закрытое не переписывается. Отказ без причины база не примет.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {open.length === 0 && (
        <p className="empty">
          Необработанных обращений нет. Новые приходят с сайта, из WhatsApp и
          от звонков — тем, кто их регистрирует.
        </p>
      )}

      <div className="rows">
        {open.map((i) => (
          <article
            key={i.id}
            className={i.status === "new" && i.age_hours > 24 ? "row alarm" : "row"}
          >
            <div className="row-main">
              <h3>
                {i.contact_name || "Без имени"}{" "}
                <span className="muted">{INTENT[i.intent] ?? i.intent}</span>
              </h3>
              {i.contact_phone && <p className="phone">{formatPhone(i.contact_phone)}</p>}
              {i.body && <p className="note">{i.body}</p>}
              <p className="muted">
                {CHANNEL[i.channel] ?? i.channel}
                {i.source ? ` · ${i.source}` : ""} · ждёт {waited(i.age_hours)}
                {i.received_by_name ? ` · принял ${i.received_by_name}` : ""}
                {i.about_object_address ? ` · по объекту ${i.about_object_address}` : ""}
              </p>
            </div>

            <div className="row-state">
              <span className={`chip ${i.status}`}>{STATUS[i.status] ?? i.status}</span>
            </div>

            <div className="row-acts">
              {i.status === "new" && (
                <ActionForm action={qualifyInquiry} label="Взять в работу">
                  <input type="hidden" name="inquiry_id" value={i.id} />
                </ActionForm>
              )}
              <details className="fold">
                <summary>Отказ</summary>
                <ActionForm action={rejectInquiry} label="Отказать">
                  <input type="hidden" name="inquiry_id" value={i.id} />
                  <input name="reason" placeholder="Причина — обязательна" required />
                  <label className="check">
                    <input type="checkbox" name="spam" /> спам
                  </label>
                </ActionForm>
              </details>
            </div>
          </article>
        ))}
      </div>

      {closed.length > 0 && (
        <>
          <h2>Закрытые <span className="muted">({closed.length})</span></h2>
          <p className="muted">
            Спам не считается в воронке конверсии: иначе чем больше спама, тем
            «лучше» выглядят цифры.
          </p>
          <div className="rows compact">
            {closed.slice(0, 20).map((i) => (
              <article key={i.id} className="row">
                <div className="row-main">
                  <h3>{i.contact_name || "Без имени"}</h3>
                  <p className="muted">
                    {i.rejection_reason ?? i.body ?? ""}
                  </p>
                </div>
                <div className="row-state">
                  <span className={`chip ${i.status}`}>{STATUS[i.status] ?? i.status}</span>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
