import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channels as channelList, objectChannels, objectDetail } from "../../../../lib/cabinet";
import { plural, formatPrice, KIND_LABEL, freshness, formatDate, formatDateTime, formatArea, formatPhone, formatShare, PUBLICATION_LABEL } from "../../../../lib/format";
import { gate } from "../../Gate";
import { Photos } from "../../Photos";
import { Channels } from "../../Channels";
import { Transfer } from "../../Transfer";
import { transferTargets } from "../../../../lib/cabinet";
import { transferObject } from "../../actions";
import { ActionForm } from "../../ActionForm";
import { confirmActual, issueOwnerLink, publish, withdraw } from "../../actions";

const MANDATE_LABEL: Record<string, string> = {
  exclusive: "эксклюзив",
  non_exclusive: "альтернатива",
};

export const metadata: Metadata = {
  title: "Объект",
  robots: { index: false, follow: false },
};

export default async function ObjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { id } = await params;
  const { note } = await searchParams;
  const data = await objectDetail(id);
  const channels = await objectChannels(id);
  const feeds = await channelList();
  if (!data) notFound();

  const targets = data.canEditPhotos ? await transferTargets() : [];

  const o = data.object;

  return (
    <div className="wrap">
      <p className="back"><a href="/cabinet/objects">← к объектам</a></p>
      <h1>{o.address}</h1>
      {note && <p className="ok-banner">{note}</p>}

      <p className="row-price big">{formatPrice(o.price, o.currency, o.deal_type as never)}</p>
      <p className="row-meta">
        {KIND_LABEL[o.kind as keyof typeof KIND_LABEL] ?? o.kind}
        {o.rooms ? `, ${o.rooms} комн.` : ""}
        {o.area ? `, ${formatArea(o.area)}` : ""}
        {o.zone ? ` · ${o.zone}` : ""}
      </p>

      <p>
        <span className={`chip ${o.publication_state}`}>
          {PUBLICATION_LABEL[o.publication_state] ?? o.publication_state}
        </span>
        {/* Инвариант 37. Договор берётся из app.object_terms_v, а не из
            таблицы: по чужому объекту таблица молчит, и карточка писала «нет
            действующего договора» там, где договор есть и подтверждён. Хуже
            пустоты: это утверждение, и оно было ложным. */}
        {data.terms.has_mandate ? (
          data.terms.contract_confirmed ? (
            <span className="chip ok">
              {MANDATE_LABEL[data.terms.mandate_kind ?? ""] ?? "договор"} подтверждён
              {data.terms.valid_to ? ` до ${formatDate(data.terms.valid_to)}` : ""}
            </span>
          ) : (
            <span className="chip warn">
              {MANDATE_LABEL[data.terms.mandate_kind ?? ""] ?? "договор"} на словах — бумага не подтверждена
            </span>
          )
        ) : (
          <span className="chip danger">нет действующего договора</span>
        )}
        <span className="chip">{freshness(o.actual_at).label}</span>
      </p>

      {/* Чьё агентство ведёт объект. Для чужого это первое, что надо знать:
          с кем договариваться о показе и на чём держится комиссия. */}
      {data.terms.source === "other" ? (
        <p className="warn-banner">
          Объект другой организации:{" "}
          <b>{data.terms.agency_name ?? "агентство не названо"}</b>
          {data.terms.holder_agent_name ? `, ведёт ${data.terms.holder_agent_name}` : ""}
          {data.terms.holder_certified
            ? " — агент в реестре риэлторов ТПП"
            : " — агент не в реестре ТПП"}. Править, публиковать и снимать его
          может только она. Вы можете предложить его своему клиенту и
          назначить показ — договорившись с агентом объекта.
        </p>
      ) : data.terms.source === "agency" && data.terms.holder_agent_name ? (
        <p className="muted">Ведёт {data.terms.holder_agent_name}, ваша организация.</p>
      ) : null}

      {o.stale_reasons && o.stale_reasons.length > 0 && (
        <ul className="reasons wide">
          {o.stale_reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}

      {/* Экспозиция. Показывается только у опубликованного объекта: у
          черновика её не бывает, и нули там означали бы не «не смотрят», а
          «неоткуда смотреть».

          Числа названы «на нашем каталоге» не из скромности. Площадка не
          сообщает нам ни просмотров, ни звонков, и подписать эти числа просто
          «просмотры» значило бы выдать свои за общие — то есть соврать
          агенту, а через него собственнику. Та же мысль, что на экране
          площадок про строчку «размещено». */}
      {o.publication_state === "published" && (
        <section className="exposure">
          <h2>Экспозиция на нашем каталоге</h2>
          <p className="stats">
            <span><strong>{o.views_7}</strong> за неделю</span>
            <span><strong>{o.views_30}</strong> за месяц</span>
            <span><strong>{o.views_total}</strong> всего</span>
            <span>
              <strong>{o.inquiries_total}</strong>{" "}
              {plural(o.inquiries_total, "обращение", "обращения", "обращений")}
            </span>
            {o.days_published !== null && (
              <span><strong>{o.days_published}</strong>{" "}
                {plural(o.days_published, "день", "дня", "дней")} в каталоге</span>
            )}
          </p>
          {/* Совет даётся только там, где есть о чём говорить.
              Первая версия писала «смотрят, но не обращаются» объекту,
              опубликованному сегодня, по двум открытиям — то есть выдавала
              догадку с уверенным лицом. Два числа это не наблюдение, а шум;
              порог ниже выбран так, чтобы молчать, пока сказать нечего. */}
          {o.views_total === 0 && (o.days_published ?? 0) >= 3 ? (
            <p className="muted sm">
              За {o.days_published}{" "}
              {plural(o.days_published ?? 0, "день", "дня", "дней")} карточку
              не открыли ни разу. Это про наш каталог: на площадках объект мог
              и показываться — они нам этого не сообщают.
            </p>
          ) : o.inquiries_total === 0 && o.views_30 >= 10 ? (
            <p className="muted sm">
              Смотрят, но не обращаются. Обычно это разговор о цене или о
              фотографиях, а не о том, что объект не видят.
            </p>
          ) : null}
        </section>
      )}

      {data.canEditObject && (
        <section className="acts-bar">
          <a className="btn" href={`/cabinet/objects/${o.id}/edit`}>Править</a>
        </section>
      )}

      {o.is_mine && (
        <section className="acts-bar">
          <ActionForm action={confirmActual} label="Подтвердить актуальность">
            <input type="hidden" name="object_id" value={o.id} />
          </ActionForm>
          {o.publication_state === "published" ? (
            <ActionForm action={withdraw} label="Снять с каталога" danger
              confirm="Снять объект с публикации? Ссылки на фотографии перестанут работать сразу.">
              <input type="hidden" name="object_id" value={o.id} />
            </ActionForm>
          ) : (
            <ActionForm action={publish} label="В каталог">
              <input type="hidden" name="object_id" value={o.id} />
            </ActionForm>
          )}
        </section>
      )}

      {data.canEditPhotos && (
        <section>
          <Transfer
            action={transferObject}
            what="объект"
            hidden={{ object_id: o.id }}
            targets={targets}
            note="Договор с собственником перейдёт на него, и править объект будете уже не вы. Незакрытые сделки перейдут вместе с объектом, закрытые останутся за прежним агентом."
          />
        </section>
      )}

      <Photos
        objectId={o.id}
        photos={data.photos}
        canEdit={data.canEditPhotos}
        limit={data.photoLimit}
        whyNot={
          data.terms.source === "other"
            ? "Фотографии объекта ведёт то агентство, с которым у собственника договор. Предложить этот объект клиенту и назначить показ вы можете, а снимки — нет."
            : data.terms.has_mandate
              ? "Фотографии ведёт listing-агент действующего договора. По этому объекту договор у другого агента."
              : "Фотографии можно добавить только при действующем договоре с собственником: отвечать за снимки перед ним должен тот, с кем договор. Заключите договор — форма загрузки появится."
        }
      />

      {/* Площадок чужого объекта мы не знаем: политика каналов их не
          показывает, и список выходил бы из умолчаний — три строки «не
          отдаём» про чужую рекламу. Это не пустота, это неправда. */}
      {data.terms.source === "other" ? (
        <section>
          <h2>Площадки</h2>
          <p className="muted">
            Рекламой этого объекта распоряжается{" "}
            {data.terms.agency_name ?? "другое агентство"}. Куда оно его
            выгружает, мы не знаем и показывать не будем.
          </p>
        </section>
      ) : (
        <Channels
          objectId={o.id}
          items={channels}
          available={feeds.map((f) => f.channel)}
          canEdit={data.canManageChannels}
          whyNot="Площадками объекта распоряжается агент действующего договора: снять чужой объект с площадки — это выключить чужую рекламу."
        />
      )}

      <section>
        <h2>Собственник</h2>
        {data.owners.length === 0 ? (
          /* Пустой список — это два разных ответа. «Не записан» можно
             сказать только про свой объект; у чужого собственник записан, но
             его карточка принадлежит другому агентству (инвариант 4). */
          data.terms.source === "other" ? (
            <p className="muted">
              Собственник записан в{" "}
              {data.terms.agency_name ?? "другом агентстве"}, и его карточка
              принадлежит ему. Договариваться о показе — с агентом объекта.
            </p>
          ) : (
            <p className="empty">Собственник не записан.</p>
          )
        ) : (
          data.owners.map((ow) => (
            <article key={ow.contact_id} className="card">
              <h3>{ow.name}{formatShare(ow.share) ? ` · доля ${formatShare(ow.share)}` : ""}</h3>
              {ow.phones.length > 0 ? (
                <p className="phone">{ow.phones.map(formatPhone).join(", ")}</p>
              ) : (
                <p className="muted">
                  Телефон не показан: он виден владельцу мандата, участникам
                  активной сделки и администратору. Это инвариант 4, и решает
                  его база, а не этот экран.
                </p>
              )}

              <h4>Ссылка на отчёт собственнику</h4>
              {data.ownerLinks
                .filter((l) => l.contact_id === ow.contact_id)
                .map((l) => (
                  <p key={l.token} className="link-box">
                    <code>/report/{l.token}</code>
                    <span className="muted">
                      до {formatDate(l.expires_at)} · открывали {l.view_count} раз
                    </span>
                  </p>
                ))}
              {o.is_mine && (
                <ActionForm action={issueOwnerLink} label="Выдать ссылку">
                  <input type="hidden" name="object_id" value={o.id} />
                  <input type="hidden" name="contact_id" value={ow.contact_id} />
                  <label>
                    Ссылка действует дней
                    <input name="days" type="number" min={1} max={180} defaultValue={30} />
                  </label>
                </ActionForm>
              )}
            </article>
          ))
        )}
      </section>

      <section>
        <h2>Подборы <span className="muted">({data.matches.length})</span></h2>
        {data.matches.length === 0 ? (
          <p className="empty">
            {data.terms.source === "other"
              ? "Ваших подборов по этому объекту нет. Чужие вы и не увидите: подбор принадлежит агентству, которое его сделало."
              : "Подборов по этому объекту нет."}
          </p>
        ) : (
          <ul className="plain">
            {data.matches.map((m) => (
              <li key={m.match_id}>
                {m.client_name ?? "клиент"} — <span className="chip">{m.match_status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Показы <span className="muted">({data.showings.length})</span></h2>
        {data.showings.length === 0 ? (
          <p className="empty">
            {data.terms.source === "other"
              ? "Ваших показов по этому объекту не было."
              : "Показов не было."}
          </p>
        ) : (
          <ul className="plain">
            {data.showings.map((sh) => (
              <li key={sh.id}>
                {formatDateTime(sh.scheduled_at)} ·{" "}
                <span className="chip">{sh.status}</span>
                {sh.outcome ? ` · ${sh.outcome}` : ""}
                {sh.agent_name ? ` · ${sh.agent_name}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
