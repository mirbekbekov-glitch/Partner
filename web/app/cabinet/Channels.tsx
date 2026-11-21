import type { ObjectChannel } from "../../lib/cabinet";
import { formatDateTime } from "../../lib/format";
import { ActionForm } from "./ActionForm";
import { setChannel } from "./actions";

const LABEL: Record<string, string> = {
  site: "Сайт платформы",
  mini_app: "Мини-приложение",
  lalafo: "Lalafo",
  house_kg: "House.kg",
};

/**
 * Площадки объекта.
 *
 * Показывает ровно две вещи: отдаём ли мы объект в этот канал и когда оттуда
 * приходили за фидом. «Размещено» здесь нет — площадка нам этого не
 * сообщает, и говорить за неё значит врать собственнику в отчёте.
 *
 * Состояние «включено, но объекта нет в каталоге» показывается отдельно и
 * красным: именно в нём агент уверен, что объявление висит, а его нет.
 */
export function Channels({
  objectId,
  items,
  available,
  canEdit,
  whyNot,
}: {
  objectId: string;
  items: ObjectChannel[];
  /** Куда агентство вообще отдаёт: каналы, у которых есть фид. */
  available: string[];
  canEdit: boolean;
  whyNot: string;
}) {
  // Рисуются ВСЕ площадки, а не только те, по которым уже есть запись. Иначе
  // у нового объекта включать было бы нечего: строка в таблице появляется
  // только после первого включения, а кнопка «отдавать» рисовалась по строке.
  const known = new Map(items.map((c) => [c.channel, c]));
  const outward: ObjectChannel[] = available.map(
    (channel) =>
      known.get(channel) ?? {
        channel,
        enabled: false,
        in_catalog: false,
        state: "не отдаём",
        last_error: null,
        channel_fetched_at: null,
      },
  );

  return (
    <section>
      <h2>Площадки</h2>
      <p className="muted">
        Площадка забирает фид сама. Фид — это каталог: объект, снятый с
        публикации, уходит с площадки в ту же секунду, отдельно снимать его не
        нужно.
      </p>

      {outward.length === 0 && (
        <p className="empty">
          Площадок нет: ни у одного канала не настроен фид.
        </p>
      )}

      <div className="rows">
        {outward.map((c) => {
          const stuck = c.enabled && !c.in_catalog;
          return (
            <article key={c.channel} className={stuck ? "row alarm" : "row"}>
              <div className="row-main">
                <h3>{LABEL[c.channel] ?? c.channel}</h3>
                <p className={stuck ? "act-err" : "row-meta"}>{c.state}</p>
                {c.last_error && <p className="act-err">{c.last_error}</p>}
              </div>

              <div className="row-state">
                <span className={`chip ${c.enabled && c.in_catalog ? "ok" : ""}`}>
                  {c.enabled ? "отдаём" : "не отдаём"}
                </span>
                <p className="muted">
                  {c.channel_fetched_at
                    ? `за фидом приходили ${formatDateTime(c.channel_fetched_at)}`
                    : "за фидом ещё не приходили"}
                </p>
              </div>

              {canEdit && (
                <div className="row-acts">
                  <ActionForm
                    action={setChannel}
                    label={c.enabled ? "Не отдавать" : "Отдавать"}
                    danger={c.enabled}
                  >
                    <input type="hidden" name="object_id" value={objectId} />
                    <input type="hidden" name="channel" value={c.channel} />
                    <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                  </ActionForm>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {!canEdit && <p className="muted">{whyNot}</p>}
    </section>
  );
}
