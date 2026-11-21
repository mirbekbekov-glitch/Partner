import type { Metadata } from "next";
import {
  LISTING_STAGES,
  listingFunnel,
  me,
  workload,
  type ListingCard,
} from "../../../lib/cabinet";
import { DEAL_LABEL, KIND_LABEL, formatPrice, plural } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { confirmMandate, createTask, setOwnerStage, signMandate } from "../actions";

export const metadata: Metadata = {
  title: "Объекты в работе",
  robots: { index: false, follow: false },
};

/** Завтра в 10 утра по Бишкеку — значение по умолчанию для напоминания. */
function tomorrowMorning(): string {
  const d = new Date(Date.now() + 6 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString().slice(0, 16);
}

/**
 * Договор одной строкой — главное, что агент из другого агентства должен
 * узнать об объекте раньше всего остального. До инварианта 32 этого не
 * показывал никто, включая нас.
 */
function Contract({ card }: { card: ListingCard }) {
  // Цвет здесь несёт смысл, а не украшает, и первая версия путала два
  // разных состояния. На ранних этапах договора ещё НЕ ДОЛЖНО быть — это
  // не риск, а начало работы, и красный там кричит зря. Риск начинается
  // тогда, когда агент уже работает: договор есть и не подписан, или
  // объект рекламируется без подписи.
  const early = ["new", "called", "visited"].includes(card.stage);

  if (!card.mandate_kind) {
    return early
      ? <p className="faint xs">договора пока нет</p>
      : <p className="risk">договора нет</p>;
  }
  const kind = card.mandate_kind === "exclusive" ? "эксклюзив" : "неэксклюзив";
  if (!card.contract_confirmed) {
    return <p className="risk">{kind}, не подписан</p>;
  }
  return <p className="ok-line">{kind}, подписан</p>;
}

function Card({ card, due }: { card: ListingCard; due: string }) {
  const early = ["new", "called", "visited"].includes(card.stage);
  const next = card.stage === "new" ? "called" : "visited";

  return (
    <article className={card.is_mine ? "fcard" : "fcard other"}>
      <h3>{card.address}</h3>
      <p className="muted sm">
        {KIND_LABEL[card.kind] ?? card.kind} · {DEAL_LABEL[card.deal_type] ?? card.deal_type}
        {card.rooms ? ` · ${card.rooms} комн.` : ""}
        {card.zone ? ` · ${card.zone}` : ""}
      </p>
      <p className="muted sm">{formatPrice(card.price, card.currency, card.deal_type)}</p>

      <Contract card={card} />

      <p className={card.stuck ? "fdays stuck" : "fdays"}>
        {card.days_in_stage === 0
          ? "сегодня здесь"
          : `${card.days_in_stage} ${plural(card.days_in_stage, "день", "дня", "дней")} здесь`}
        {card.stuck && card.stage_limit_days !== null && ` — дольше ${card.stage_limit_days}`}
      </p>

      {card.owner_name && <p className="faint xs">собственник: {card.owner_name}</p>}
      {card.showings_done > 0 && (
        <p className="faint xs">
          показов {card.showings_done}
        </p>
      )}
      {!card.is_mine && card.owner_agent_name && (
        <p className="faint xs">ведёт {card.owner_agent_name}</p>
      )}

      {/* Кнопки показываются всем, кто карточку видит: пустит или нет,
          решает база. Повторять её правила на экране значит разойтись с
          ними при первой правке. */}
      {early && (
        <ActionForm action={setOwnerStage} label={next === "called" ? "Дозвонились" : "Съездили"}
                    className="act tight">
          <input type="hidden" name="object_id" value={card.object_id} />
          <input type="hidden" name="stage" value={next} />
          <input type="hidden" name="path" value={`/cabinet/listings?deal=${card.deal_type}`} />
        </ActionForm>
      )}

      {!card.mandate_kind && (
        <details className="fold">
          <summary>Заключить договор</summary>
          <ActionForm action={signMandate} label="Заключить" className="act tight">
            <input type="hidden" name="object_id" value={card.object_id} />
            <input type="hidden" name="path" value={`/cabinet/listings?deal=${card.deal_type}`} />
            <label>
              Какой
              <select name="mandate_kind" defaultValue="non_exclusive">
                <option value="non_exclusive">Неэксклюзивный</option>
                <option value="exclusive">Эксклюзивный</option>
              </select>
            </label>
            <label>
              Действует до
              <input type="date" name="valid_to" />
            </label>
            <label className="check">
              <input type="checkbox" name="contract_confirmed" /> подписан
            </label>
            <span className="hint">
              Без подписи объект виден коллегам как риск — и это правильно.
            </span>
          </ActionForm>
        </details>
      )}

      {card.stage === "no_contract" && (
        <ActionForm action={confirmMandate} label="Договор подписан" className="act tight">
          <input type="hidden" name="object_id" value={card.object_id} />
          <input type="hidden" name="path" value={`/cabinet/listings?deal=${card.deal_type}`} />
        </ActionForm>
      )}

      {card.stage !== "sold" && (
        <details className="fold">
          <summary>Напомнить позвонить</summary>
          <ActionForm action={createTask} label="Поставить" className="act tight">
            <input type="hidden" name="object_id" value={card.object_id} />
            <input type="hidden" name="kind" value="call" />
            <input type="hidden" name="path" value={`/cabinet/listings?deal=${card.deal_type}`} />
            <input type="hidden" name="title" value={`Собственник: ${card.address}`} />
            <label>
              Когда
              <input type="datetime-local" name="due_at" defaultValue={due} required />
            </label>
          </ActionForm>
        </details>
      )}
    </article>
  );
}

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<{ deal?: string; note?: string; agent?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { deal, note, agent } = await searchParams;
  const agentMe = await me();
  const dirs = agentMe?.directions ?? ["sale", "rent"];

  // Направление по умолчанию — то, которое агент ведёт. Показывать агенту
  // аренды пустую доску продажи незачем: база всё равно ничего не отдаст.
  const current: "sale" | "rent" =
    deal === "rent" || deal === "sale" ? deal : (dirs[0] ?? "sale");

  const [cards, load] = await Promise.all([
    listingFunnel(current),
    agentMe?.is_head ? workload() : Promise.resolve([]),
  ]);

  const shown = agent ? cards.filter((c) => c.owner_agent_id === agent) : cards;
  const stuck = shown.filter((c) => c.stuck).length;
  const due = tomorrowMorning();
  const agents = [...new Map(
    cards.filter((c) => c.owner_agent_id)
      .map((c) => [c.owner_agent_id!, c.owner_agent_name ?? "без имени"]),
  )];

  return (
    <div className="wrap wide">
      <h1>Объекты в работе</h1>

      <p className="lead">
        Это сторона предложения: что происходит между «узнали об объекте» и
        «договор подписан». Первые три колонки двигает агент, дальше карточка
        переезжает сама — появился договор, появилась подпись, объект попал в
        каталог. Договор назван на каждой карточке, потому что это первое, что
        должен знать коллега, собравшийся привезти сюда покупателя.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {/* Направление — не фильтр, а отдел: агент аренды продажу не видит
          вовсе, и показывать ему переключатель незачем. */}
      {dirs.length > 1 && (
        <div className="switch">
          <a className={current === "sale" ? "on" : ""} href="/cabinet/listings?deal=sale">
            Продажа
          </a>
          <a className={current === "rent" ? "on" : ""} href="/cabinet/listings?deal=rent">
            Аренда
          </a>
        </div>
      )}

      {agentMe?.is_head && agents.length > 1 && (
        <div className="switch">
          <a className={!agent ? "on" : ""} href={`/cabinet/listings?deal=${current}`}>
            Все агенты
          </a>
          {agents.map(([id, name]) => (
            <a key={id} className={agent === id ? "on" : ""}
               href={`/cabinet/listings?deal=${current}&agent=${id}`}>
              {name}
            </a>
          ))}
        </div>
      )}

      {stuck > 0 && (
        <p className="warn">
          {stuck} {plural(stuck, "объект стоит", "объекта стоят", "объектов стоят")} в своей
          колонке дольше, чем ей отведено. Они первыми.
        </p>
      )}

      {shown.length === 0 && (
        <p className="empty">
          Объектов в этом направлении нет. Объект заводится на экране
          «Объекты» или из объявления с площадки.
        </p>
      )}

      <div className="boardwrap">
        <div className="board">
          {LISTING_STAGES.map((stage) => {
            const column = shown.filter((c) => c.stage === stage.key);
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
                  column.map((c) => <Card key={c.object_id} card={c} due={due} />)
                )}
              </section>
            );
          })}
        </div>
      </div>

      {agentMe?.is_head && load.length > 0 && (
        <>
          <h2>У кого сколько</h2>
          <p className="muted sm">
            Загрузка агентства по стадиям. Красное — то, что стоит дольше
            положенного.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Агент</th><th>Стадия</th><th>Объектов</th><th>Встало</th></tr>
              </thead>
              <tbody>
                {load.map((w) => (
                  <tr key={`${w.agent_id}-${w.stage}`}>
                    <td>{w.agent_name}</td>
                    <td>
                      {LISTING_STAGES.find((s) => s.key === w.stage)?.title ?? w.stage}
                    </td>
                    <td className="n">{w.objects}</td>
                    <td className="n">{w.stuck > 0 ? <b className="alarm-text">{w.stuck}</b> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
