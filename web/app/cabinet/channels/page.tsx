import type { Metadata } from "next";
import { channels, feedUrl, me } from "../../../lib/cabinet";
import { formatDateTime, plural } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { rotateFeedToken } from "../actions";

export const metadata: Metadata = {
  title: "Площадки",
  robots: { index: false, follow: false },
};

export const CHANNEL_LABEL: Record<string, string> = {
  site: "Сайт платформы",
  mini_app: "Мини-приложение",
  lalafo: "Lalafo",
  house_kg: "House.kg",
};

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { note } = await searchParams;
  const agent = await me();
  const list = await channels();
  const urls = agent?.is_admin
    ? Object.fromEntries(
        await Promise.all(list.map(async (c) => [c.channel, await feedUrl(c.channel)])),
      )
    : {};

  const site = process.env.SITE_URL ?? "";

  return (
    <div className="wrap">
      <h1>Площадки</h1>
      <p className="lead">
        Площадка забирает объявления сама: агентство даёт ей ссылку, она ходит
        по ней и берёт фид. Фид — это публичный каталог: что ушло из каталога,
        то в ту же секунду ушло и с площадки.
      </p>

      {note && <p className="ok-banner">{note}</p>}

      <p className="warn">
        Чего здесь нет и быть не может: строчки «размещено». Площадка не
        сообщает нам, что она разместила объект, и утверждать это за неё
        значит врать собственнику в отчёте. Мы знаем своё: что отдаём и когда
        за фидом приходили.
      </p>

      <div className="rows">
        {list.map((c) => {
          const url = urls[c.channel] as string | null | undefined;
          return (
            <article key={c.channel} className="row">
              <div className="row-main">
                <h3>{CHANNEL_LABEL[c.channel] ?? c.channel}</h3>
                <p className="row-meta">
                  {c.objects_in_feed}{" "}
                  {plural(c.objects_in_feed, "объект", "объекта", "объектов")} в фиде
                </p>
                {url && (
                  <p className="note">
                    <code>
                      {site}
                      {url}
                    </code>
                  </p>
                )}
                {!url && (
                  <p className="muted">
                    Ссылку на фид видит администратор: по ней отдаётся весь
                    каталог канала.
                  </p>
                )}
              </div>

              <div className="row-state">
                <span className={`chip ${c.last_fetched_at ? "ok" : "warn"}`}>
                  {c.last_fetched_at ? "фид забирают" : "за фидом не приходили"}
                </span>
                {c.last_fetched_at && (
                  <p className="muted">
                    последний раз {formatDateTime(c.last_fetched_at)}
                  </p>
                )}
                <p className="muted">
                  за неделю обращений: {c.fetches_week}
                </p>
                {c.rotated_at && (
                  <p className="muted">ссылка менялась {formatDateTime(c.rotated_at)}</p>
                )}
              </div>

              {agent?.is_admin && (
                <div className="row-acts">
                  <details className="fold">
                    <summary>Заменить ссылку</summary>
                    <ActionForm
                      action={rotateFeedToken}
                      label="Заменить"
                      danger
                      confirm="Старая ссылка перестанет работать сразу. Площадке придётся выдать новую. Продолжить?"
                    >
                      <input type="hidden" name="channel" value={c.channel} />
                    </ActionForm>
                  </details>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <p className="muted">
        Включается площадка у объекта — в его карточке. Там же видно, если
        объект включён, но в каталоге его нет: тогда на площадку он не уходит,
        сколько бы ни было включено.
      </p>
    </div>
  );
}
