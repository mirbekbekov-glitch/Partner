import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { objectDetail } from "../../../../lib/cabinet";
import { formatPrice, KIND_LABEL, freshness, formatDate, formatDateTime, formatArea, formatPhone, formatShare, PUBLICATION_LABEL } from "../../../../lib/format";
import { gate } from "../../Gate";
import { Photos } from "../../Photos";
import { Transfer } from "../../Transfer";
import { transferTargets } from "../../../../lib/cabinet";
import { transferObject } from "../../actions";
import { ActionForm } from "../../ActionForm";
import { confirmActual, issueOwnerLink, publish, withdraw } from "../../actions";

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
        {o.mandate_status === "active" ? (
          <span className="chip ok">
            договор действует{o.mandate_valid_to ? ` до ${formatDate(o.mandate_valid_to)}` : " бессрочно"}
          </span>
        ) : (
          <span className="chip danger">нет действующего договора</span>
        )}
        <span className="chip">{freshness(o.actual_at).label}</span>
      </p>

      {o.stale_reasons && o.stale_reasons.length > 0 && (
        <ul className="reasons wide">
          {o.stale_reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
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
          o.mandate_status === "active"
            ? "Фотографии ведёт listing-агент действующего договора. По этому объекту договор у другого агента."
            : "Фотографии можно добавить только при действующем договоре с собственником: отвечать за снимки перед ним должен тот, с кем договор. Заключите договор — форма загрузки появится."
        }
      />

      <section>
        <h2>Собственник</h2>
        {data.owners.length === 0 ? (
          <p className="empty">Собственник не записан.</p>
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
          <p className="empty">Подборов по этому объекту нет.</p>
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
          <p className="empty">Показов не было.</p>
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
