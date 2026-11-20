import { formatPrice } from "../../lib/format";
import type { Showing } from "../../lib/cabinet";
import { ActionForm } from "./ActionForm";
import {
  cancelShowing,
  completeShowing,
  markNoShow,
  rescheduleShowing,
} from "./actions";

/**
 * Назначенный показ.
 *
 * Четыре исхода, и все четыре нужны: показ прошёл, клиент не пришёл, показ
 * перенесли, показ отменили. До инварианта 25 кнопок было две — «прошёл» и
 * «отменить», — и неявка записывалась отменой. Собственнику в отчёте это
 * говорит разное: отменил агент или клиент не приехал.
 *
 * Кнопки показываются всем, кто показ видит, а решает база: двигать показ
 * может участник подбора, проводящий агент или админ. Прятать кнопку у
 * коллеги здесь значило бы повторить правило второй раз и разойтись с ним
 * при первой правке.
 */
/** «2026-11-21T11:00» по Бишкеку — тот формат, который принимает datetime-local. */
function bishkekLocal(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bishkek",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return parts.replace(" ", "T");
}

export function ShowingCard({
  s,
  clock,
  overdue,
}: {
  s: Showing;
  clock: (value: Date | string) => string;
  overdue?: boolean;
}) {
  return (
    <article className={overdue ? "row showing late" : "row showing"}>
      <div className="showing-when">
        {/* Машиночитаемое время в поясе агентства: его же формат ждёт
            datetime-local при переносе, и по нему идёт проход walk:showings. */}
        <time dateTime={bishkekLocal(s.scheduled_at)}>
          <strong>{clock(s.scheduled_at)}</strong>
        </time>
        {overdue && <em>время прошло</em>}
      </div>

      <div className="row-main">
        <h3>
          <a href={`/cabinet/objects/${s.object_id}`}>{s.address}</a>
        </h3>
        <p className="row-meta">
          {s.client_name ? (
            <a href={`/cabinet/requirements/${s.requirement_id}`}>{s.client_name}</a>
          ) : (
            "клиент"
          )}
          {" · "}
          {s.zone ?? "—"}
          {" · "}
          {formatPrice(s.price, s.currency, s.deal_type as never)}
          {" · "}
          {s.i_lead ? "показываете вы" : `показывает ${s.agent_name ?? "—"}`}
        </p>
        {s.note && <p className="note">{s.note}</p>}
      </div>

      <div className="row-acts">
        <details className="fold">
          <summary>Показ прошёл</summary>
          <ActionForm action={completeShowing} label="Записать исход">
            <input type="hidden" name="showing_id" value={s.id} />
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
            <input type="hidden" name="showing_id" value={s.id} />
            <input name="note" placeholder="Что известно" />
          </ActionForm>
        </details>

        <details className="fold">
          <summary>Перенести</summary>
          <ActionForm action={rescheduleShowing} label="Перенести">
            <input type="hidden" name="showing_id" value={s.id} />
            <input type="datetime-local" name="at" required />
          </ActionForm>
        </details>

        <details className="fold">
          <summary>Отменить</summary>
          <ActionForm action={cancelShowing} label="Отменить показ" danger>
            <input type="hidden" name="showing_id" value={s.id} />
            <input name="reason" placeholder="Причина — обязательна" required />
          </ActionForm>
        </details>
      </div>
    </article>
  );
}
