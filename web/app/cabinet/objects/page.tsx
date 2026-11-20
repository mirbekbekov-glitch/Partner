import type { Metadata } from "next";
import { myObjects } from "../../../lib/cabinet";
import { formatPrice, formatArea, KIND_LABEL, freshness, formatDate, PUBLICATION_LABEL } from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { confirmActual, publish, withdraw } from "../actions";

export const metadata: Metadata = {
  title: "Объекты",
  robots: { index: false, follow: false },
};

export default async function ObjectsPage() {
  const access = await gate();
  if (!access.ok) return access.screen;

  const items = await myObjects();
  const mine = items.filter((o) => o.is_mine);
  const others = items.filter((o) => !o.is_mine);

  return (
    <div className="wrap">
      <div className="head-row">
        <h1>Объекты</h1>
        <a className="btn primary" href="/cabinet/objects/new">Новый объект</a>
      </div>
      <p className="lead">
        Сначала ваши, внутри — те, что требуют действия: просроченный
        договор, незаключённый договор, публикация без фотографий. Объект
        попадает в каталог только при действующем договоре — это правило
        базы, а не проверка формы, и кнопка «В каталог» на объекте без
        мандата просто откажет.
      </p>

      {mine.length === 0 && (
        <p className="empty">
          За вами пока не записано ни одного объекта. Объекты создаются из
          обращения собственника или из объявления с площадки.
        </p>
      )}

      <ObjectTable items={mine} />

      {others.length > 0 && (
        <>
          <h2>Объекты коллег <span className="muted">({others.length})</span></h2>
          <p className="muted">
            Видны для работы по подбору. Телефон собственника здесь не
            показывается — он виден владельцу мандата и участникам активной
            сделки (инвариант 4).
          </p>
          <ObjectTable items={others} readOnly />
        </>
      )}
    </div>
  );
}

function ObjectTable({
  items,
  readOnly,
}: {
  items: Awaited<ReturnType<typeof myObjects>>;
  readOnly?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="rows">
      {items.map((o) => (
        <article key={o.id} className={o.severity === "critical" ? "row alarm" : "row"}>
          <div className="row-main">
            <h3>
              <a href={`/cabinet/objects/${o.id}`}>{o.address}</a>
            </h3>
            <p className="row-meta">
              {KIND_LABEL[o.kind as keyof typeof KIND_LABEL] ?? o.kind}
              {o.rooms ? `, ${o.rooms} комн.` : ""}
              {o.area ? `, ${formatArea(o.area)}` : ""}
              {o.zone ? ` · ${o.zone}` : ""}
            </p>
            <p className="row-price">
              {formatPrice(o.price, o.currency, o.deal_type as never)}
            </p>
          </div>

          <div className="row-state">
            <State object={o} />
            {o.stale_reasons && o.stale_reasons.length > 0 && (
              <ul className="reasons">
                {o.stale_reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          {!readOnly && (
            <div className="row-acts">
              <ActionForm action={confirmActual} label="Подтвердить актуальность">
                <input type="hidden" name="object_id" value={o.id} />
              </ActionForm>
              {o.publication_state === "published" ? (
                <ActionForm
                  action={withdraw}
                  label="Снять с каталога"
                  danger
                  confirm="Снять объект с публикации? В каталоге он исчезнет сразу, вместе с фотографиями."
                >
                  <input type="hidden" name="object_id" value={o.id} />
                </ActionForm>
              ) : (
                <ActionForm action={publish} label="В каталог">
                  <input type="hidden" name="object_id" value={o.id} />
                </ActionForm>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function State({ object: o }: { object: Awaited<ReturnType<typeof myObjects>>[number] }) {
  return (
    <>
      <p>
        <span className={`chip ${o.publication_state}`}>
          {PUBLICATION_LABEL[o.publication_state] ?? o.publication_state}
        </span>
        {o.mandate_status === "active" ? (
          o.contract_confirmed ? (
            <span className="chip ok">договор подтверждён</span>
          ) : (
            <span className="chip warn">договор не подтверждён</span>
          )
        ) : (
          <span className="chip danger">нет действующего договора</span>
        )}
        {o.photos_count === 0 && <span className="chip warn">без фото</span>}
      </p>
      <p className="muted">
        {freshness(o.actual_at).label}
        {o.mandate_valid_to ? ` · договор до ${formatDate(o.mandate_valid_to)}` : ""}
      </p>
    </>
  );
}
