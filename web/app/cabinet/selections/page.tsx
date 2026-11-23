import type { Metadata } from "next";
import {
  requirements,
  selectable,
  selectionItems,
  selections,
  type Requirement,
  type Selection,
} from "../../../lib/cabinet";
import {
  DEAL_LABEL,
  formatBudget,
  formatDateTime,
  formatPrice,
  plural,
} from "../../../lib/format";
import type { DealType } from "../../../lib/types";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import {
  createSelection,
  revokeSelection,
  sendSelection,
  setSelectionReaction,
} from "../actions";

export const metadata: Metadata = {
  title: "Подборки",
  robots: { index: false, follow: false },
};

const REACTION: Record<string, string> = {
  liked: "нравится",
  maybe: "думает",
  disliked: "не подошло",
};

/**
 * Подпись потребности в списке «для кого собрать».
 *
 * Одного имени мало. У контакта может быть несколько потребностей сразу —
 * база это разрешает намеренно, — и тогда в списке появляются две кнопки
 * «Гульмира Токтоева», между которыми не выбрать. Различает их то, зачем
 * человек пришёл: тип сделки и бюджет.
 */
function needLabel(r: Requirement): string {
  const name = r.client_name ?? "без имени";
  const deal = DEAL_LABEL[r.deal_type as DealType] ?? r.deal_type;
  return `${name} · ${deal.toLowerCase()}, ${formatBudget(r.budget_min, r.budget_max)}`;
}

function stateClass(s: Selection): string {
  if (s.revoked_at) return "chip";
  if (!s.sent_at) return "chip warn";
  if (s.state === "срок вышел") return "chip";
  if (!s.first_opened_at) return "chip warn";
  return "chip ok";
}

export default async function SelectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string; open?: string; forr?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  // Телефон в профиле необязателен, а подборка на него опирается: на листе
  // клиента это единственное, по чему можно позвонить. Без предупреждения
  // агент узнавал бы об этом от клиента, который не дозвонился.
  const noPhone = !access.agent.phone;

  const { note, open, forr } = await searchParams;
  const [list, clients] = await Promise.all([selections(), requirements()]);
  // Свои и живые. Клиент, который купил или ушёл, в списке «для кого собрать»
  // только мешает: подборку ему уже не отправляют, а имя занимает строку.
  const mine = clients.filter(
    (r) => r.is_mine && r.status !== "closed" && r.status !== "lost",
  );

  const opened = open ? list.find((s) => s.id === open) : undefined;
  const items = opened ? await selectionItems(opened.id) : [];
  const picking = forr ? await selectable(forr) : [];
  const pickingFor = forr ? mine.find((r) => r.id === forr) : undefined;

  return (
    <div className="wrap">
      <h1>Подборки</h1>

      <p className="lead">
        Подборка — это то, что клиент получил. Пока она черновик, состав
        меняется; после отправки — нет: «клиент видел пять вариантов» не
        должно меняться задним числом. Отправлено и открыто — разные факты, и
        пока клиент не открыл ссылку, мы знаем только первое.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      {/* Без телефона в профиле подборка уходит клиенту без контакта: на
          листе названы агентство и дата, а звонить некуда. Молчать об этом
          нельзя — агент узнал бы от клиента, который не дозвонился. */}
      {noPhone && (
        <p className="warn-banner">
          В вашем профиле нет телефона, и на подборках у клиента не будет
          номера, по которому вам звонить. <a href="/cabinet/profile">Указать</a>.
        </p>
      )}

      {/* Собрать новую. Варианты не вводятся руками: их считает подбор в
          базе — тот же, что на карточке клиента. */}
      <section className="card">
        <h2>Собрать подборку</h2>
        {mine.length === 0 ? (
          <p className="muted">У вас нет клиентов, для которых её собрать.</p>
        ) : !pickingFor ? (
          <>
            <p className="muted sm">Для кого:</p>
            <div className="switch">
              {mine.slice(0, 12).map((r) => (
                <a key={r.id} href={`/cabinet/selections?forr=${r.id}`}>
                  {needLabel(r)}
                </a>
              ))}
            </div>
            {mine.length > 12 && (
              <p className="faint sm">
                Показаны 12 из {mine.length}: остальных видно на экране
                «Клиенты», подборка собирается с карточки.
              </p>
            )}
          </>
        ) : picking.length === 0 ? (
          <p className="empty">
            Под условия клиента {pickingFor.client_name ?? ""} сейчас ничего не
            подходит. Это не пустой экран, а ответ: показывать нечего.
          </p>
        ) : (
          <ActionForm action={createSelection} label="Собрать" className="act">
            <input type="hidden" name="requirement_id" value={forr} />
            <p className="muted sm">
              Для {needLabel(pickingFor)} — отметьте варианты:
            </p>
            {picking.map((o) => (
              <label key={o.object_id} className="check">
                <input type="checkbox" name="object_id" value={o.object_id} />
                {o.address} · {formatPrice(o.price, o.currency, "sale")}
                {o.rooms ? ` · ${o.rooms} комн.` : ""}
                {o.fit !== "в бюджет" && <span className="chip warn">{o.fit}</span>}
                {o.already_proposed && <span className="chip">уже предлагали</span>}
                {o.source === "other" && (
                  <span className="chip">{o.agency_name ?? "другая организация"}</span>
                )}
              </label>
            ))}
            <label>
              Что написать клиенту
              <input name="note" maxLength={200}
                     placeholder="Три варианта в центре, смотреть можно завтра" />
            </label>
          </ActionForm>
        )}
      </section>

      {list.length === 0 && (
        <p className="empty">Подборок пока нет.</p>
      )}

      {list.map((s) => (
        <article key={s.id} className="row">
          <div className="main">
            <p className="title">
              {s.client_name ?? "без имени"}{" "}
              <span className={stateClass(s)}>{s.state}</span>
            </p>
            <p className="muted sm">
              {s.objects} {plural(s.objects, "объект", "объекта", "объектов")}
              {s.sent_at && ` · отправлена ${formatDateTime(s.sent_at)}`}
              {s.first_opened_at
                ? ` · открыта ${formatDateTime(s.first_opened_at)}, просмотров ${s.view_count}`
                : s.sent_at && " · клиент её ещё не открывал"}
              {s.liked > 0 && ` · понравилось ${s.liked}`}
            </p>
            {s.note && <p className="faint sm">«{s.note}»</p>}
            {s.sent_at && !s.revoked_at && (
              <p className="faint sm">
                ссылка клиенту: <code>/selection/{s.token}</code>
              </p>
            )}
          </div>
          <div className="side">
            {!s.sent_at && (
              <ActionForm action={sendSelection} label="Отправить" className="act tight">
                <input type="hidden" name="selection_id" value={s.id} />
              </ActionForm>
            )}
            <a className="btn inline" href={`/cabinet/selections?open=${s.id}`}>
              Что внутри
            </a>
            {s.sent_at && !s.revoked_at && (
              <details className="fold">
                <summary>Отозвать</summary>
                <ActionForm action={revokeSelection} label="Отозвать"
                            className="act tight" danger>
                  <input type="hidden" name="selection_id" value={s.id} />
                  <span className="hint">
                    Клиент перестанет открывать ссылку. Запись о том, что он
                    получил, остаётся.
                  </span>
                </ActionForm>
              </details>
            )}
          </div>
        </article>
      ))}

      {opened && (
        <>
          <h2>Что внутри: {opened.client_name ?? "без имени"}</h2>
          <p className="muted sm">
            Реакция клиента — это задание на следующий подбор: «что не
            подошло» объясняет больше, чем «не понравилось».
          </p>
          {items.map((i) => (
            <article key={i.object_id} className="row">
              <div className="main">
                <p className="title">{i.address}</p>
                <p className="muted sm">
                  {formatPrice(i.price, i.currency, i.deal_type)}
                  {i.rooms ? ` · ${i.rooms} комн.` : ""}
                  {i.zone ? ` · ${i.zone}` : ""}
                  {i.reaction && ` · ${REACTION[i.reaction] ?? i.reaction}`}
                </p>
                {i.note && <p className="faint sm">«{i.note}»</p>}
              </div>
              <div className="side">
                {(["liked", "maybe", "disliked"] as const).map((r) => (
                  <ActionForm key={r} action={setSelectionReaction}
                              label={REACTION[r]} className="act tight">
                    <input type="hidden" name="selection_id" value={opened.id} />
                    <input type="hidden" name="object_id" value={i.object_id} />
                    <input type="hidden" name="reaction" value={r} />
                    {r === "disliked" && (
                      <input name="note" placeholder="что не подошло" maxLength={120} />
                    )}
                  </ActionForm>
                ))}
              </div>
            </article>
          ))}
        </>
      )}
    </div>
  );
}
