import type { Metadata } from "next";
import { channels, feedUrl, me } from "../../../lib/cabinet";
import { formatDateTime, formatPhone, plural } from "../../../lib/format";
import { FORMAT_LABEL } from "../../../lib/feeds";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { rotateFeedToken, setFeedFormat } from "../actions";

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
        Схема фида — настройка канала, а не выдумка в коде. Для Лалафо и
        House.kg выбрана схема Яндекс.Недвижимости: в СНГ её принимают чаще
        прочих. Это <strong>предположение</strong> — спецификацию площадки
        выдают вместе с тарифом, и пока она не на руках, фид обязан пройти
        валидатор площадки перед первым включением.
      </p>

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
                <span className={`chip ${c.ready ? "ok" : "danger"}`}>
                  {c.ready ? "готов отдавать" : "не настроен"}
                </span>
                <p className="muted">
                  схема: {FORMAT_LABEL[c.format] ?? c.format}
                  {/* Подтверждать нечего, когда схема наша собственная: её не
                      принимает площадка, её отдают интегратору. Красная
                      приписка там означала бы несуществующую проблему. */}
                  {c.format !== "partner" && !c.format_confirmed && (
                    <span className="act-err"> — не подтверждена площадкой</span>
                  )}
                </p>
                {c.contact_phone ? (
                  <p className="muted">контакт: {formatPhone(c.contact_phone)}</p>
                ) : c.ready ? (
                  <p className="muted">контакт этой схеме не нужен</p>
                ) : (
                  <p className="act-err">контакт для объявлений не задан</p>
                )}
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
                    <summary>Схема и контакт</summary>
                    <ActionForm action={setFeedFormat} label="Сохранить">
                      <input type="hidden" name="channel" value={c.channel} />
                      <label>
                        Схема фида
                        <select name="format" defaultValue={c.format}>
                          <option value="partner">наша схема</option>
                          <option value="yandex_realty">Яндекс.Недвижимость</option>
                          <option value="cian">ЦИАН</option>
                        </select>
                      </label>
                      <label>
                        Телефон для объявлений
                        <input
                          name="contact"
                          type="tel"
                          defaultValue={c.contact_phone ?? ""}
                          placeholder="0312 900 900"
                        />
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          name="confirmed"
                          value="1"
                          defaultChecked={c.format_confirmed}
                        />{" "}
                        схему подтвердила площадка
                      </label>
                    </ActionForm>
                  </details>
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
