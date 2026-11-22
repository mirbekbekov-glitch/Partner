import type { Metadata } from "next";
import { FUNNEL_STAGES, funnel, type FunnelCard } from "../../../lib/cabinet";
import { formatDateTime, formatBudget, plural } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { createTask, loseRequirement, qualifyRequirement } from "../actions";

export const metadata: Metadata = {
  title: "Воронка",
  robots: { index: false, follow: false },
};

/** Завтра в 10 утра по Бишкеку — значение по умолчанию для напоминания. */
function tomorrowMorning(): string {
  const now = new Date();
  const bishkek = new Date(now.getTime() + 6 * 3600 * 1000);
  bishkek.setUTCDate(bishkek.getUTCDate() + 1);
  bishkek.setUTCHours(10, 0, 0, 0);
  return bishkek.toISOString().slice(0, 16);
}

function Card({ card, due }: { card: FunnelCard; due: string }) {
  const open = card.status === "new" || card.status === "qualified"
            || card.status === "in_showings";

  return (
    <article className={card.is_mine ? "fcard" : "fcard other"}>
      {/* Имени чужого клиента здесь нет и не будет — его прячет политика
          контактов (инвариант 4). Но сама карточка видна: иначе колонка
          показывала бы ноль там, где работа идёт. */}
      {/* Карточка — вход в работу, а не ярлык. До этой правки она никуда не
          вела: чтобы собрать подборку или назначить показ по тому же
          человеку, агент уходил в «Клиенты» и искал его заново. Воронка
          показывала работу, но не давала её делать. */}
      <h3>
        <a href={`/cabinet/requirements/${card.requirement_id}`}>
          {card.contact_name ?? (card.is_mine ? "без имени" : "клиент агентства")}
        </a>
      </h3>
      <p className="muted">{formatBudget(card.budget_min, card.budget_max)}</p>
      <p className="muted">
        {card.zones.length > 0 ? card.zones.join(", ") : "район не назван"}
        {card.rooms.length > 0 && ` · ${card.rooms.join("/")} комн.`}
      </p>

      {/* Сколько стоит в колонке — главное число этого экрана. Воронка без
          него показывает количество, а спрашивают у неё всегда другое. */}
      <p className={card.stuck ? "fdays stuck" : "fdays"}>
        {card.days_in_stage === 0
          ? "сегодня здесь"
          : `${card.days_in_stage} ${plural(card.days_in_stage, "день", "дня", "дней")} здесь`}
        {card.stuck && card.stage_limit_days !== null &&
          ` — дольше ${card.stage_limit_days} ${plural(card.stage_limit_days, "дня", "дней", "дней")}`}
      </p>

      <p className="muted small">
        {card.matches_count} {plural(card.matches_count, "подбор", "подбора", "подборов")}
        {card.showings_done > 0 && ` · показов ${card.showings_done}`}
        {card.next_showing_at && ` · показ ${formatDateTime(card.next_showing_at)}`}
      </p>

      {card.open_tasks > 0 ? (
        <p className="ftask">
          напоминание {formatDateTime(card.next_task_at)}
          {card.open_tasks > 1 && ` и ещё ${card.open_tasks - 1}`}
        </p>
      ) : open && card.is_mine ? (
        <p className="ftask none">напоминания нет</p>
      ) : null}

      {!card.is_mine && <p className="muted small">ведёт {card.agent_name}</p>}
      {/* Причина показывается только у ушедшего клиента. У купившего её пишет
          триггер инварианта 2 — «закрыта сделкой <uuid>», — и агенту этот
          номер не говорит ничего: он и так стоит в колонке «Купил». */}
      {card.status === "lost" && card.closed_reason && (
        <p className="muted small">{card.closed_reason}</p>
      )}

      {/* Кнопки показываются всем, кто карточку видит: пустит или нет,
          решает база. Прятать кнопку у коллеги значило бы повторить правило
          инварианта 30 вторым экземпляром и разойтись с ним при первой
          правке. */}
      {card.status === "new" && (
        <ActionForm action={qualifyRequirement} label="Взял в работу" className="act tight">
          <input type="hidden" name="requirement_id" value={card.requirement_id} />
        </ActionForm>
      )}

      {open && (
        <details className="fold">
          <summary>Напомнить позвонить</summary>
          <ActionForm action={createTask} label="Поставить" className="act tight">
            <input type="hidden" name="requirement_id" value={card.requirement_id} />
            <input type="hidden" name="kind" value="call" />
            <input type="hidden" name="path" value="/cabinet/funnel" />
            <input
              type="hidden"
              name="title"
              value={`Перезвонить: ${card.contact_name ?? "клиент"}`}
            />
            <label>
              Когда
              <input type="datetime-local" name="due_at" defaultValue={due} required />
            </label>
          </ActionForm>
        </details>
      )}

      {open && (
        <details className="fold">
          <summary>Клиент ушёл</summary>
          <ActionForm action={loseRequirement} label="Закрыть" className="act tight" danger>
            <input type="hidden" name="requirement_id" value={card.requirement_id} />
            <label>
              Почему
              <input name="reason" placeholder="купил у соседа без агента" required
                     maxLength={200} />
              <span className="hint">
                Через полгода «просто ушёл» не объяснит ничего ни вам, ни
                руководителю.
              </span>
            </label>
          </ActionForm>
        </details>
      )}
    </article>
  );
}

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const cards = await funnel();
  const due = tomorrowMorning();
  const mine = cards.filter((c) => c.is_mine);
  const stuck = mine.filter((c) => c.stuck).length;

  return (
    <div className="wrap wide">
      <h1>Воронка</h1>

      <p className="lead">
        Колонка — это не поле, которое перетаскивают: карточка переезжает
        сама, когда случается работа. Показ прошёл — «на показах», сделка
        заведена — «в сделке», сделка закрыта — «купил». Руками делаются
        ровно два перехода, и оба — решения, а не отметки: взять клиента в
        работу и закрыть его с причиной.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {stuck > 0 && (
        <p className="warn-banner">
          {stuck} {plural(stuck, "карточка стоит", "карточки стоят", "карточек стоят")}{" "}
          в своей колонке дольше, чем ей отведено. Они первыми в каждой
          колонке.
        </p>
      )}

      {cards.length === 0 && (
        <p className="empty">
          Клиентов пока нет. Они появляются из обращений или заводятся
          вручную на экране «Клиенты».
        </p>
      )}

      {/* Семь колонок на телефоне не умещаются, и прятать их нельзя: воронка
          без «ушёл» — не воронка. Доска прокручивается вбок, как календарь
          показов. */}
      <div className="board">
        {FUNNEL_STAGES.map((stage) => {
          const column = cards.filter((c) => c.status === stage.key);
          return (
            <section key={stage.key} className="bcol">
              <header>
                <h2>
                  {stage.title} <span className="count">{column.length}</span>
                </h2>
                <p className="hint">{stage.hint}</p>
              </header>
              {column.length === 0 ? (
                <p className="bempty">пусто</p>
              ) : (
                column.map((c) => <Card key={c.requirement_id} card={c} due={due} />)
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
