import type { Metadata } from "next";
import {
  SOURCE_LABEL,
  objectZones,
  searchObjects,
  type FoundObject,
  type ObjectSearch,
  type ObjectSource,
} from "../../../lib/cabinet";
import {
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatDate,
  formatPrice,
  freshness,
  plural,
  PUBLICATION_LABEL,
} from "../../../lib/format";
import { gate } from "../Gate";
import { ActionForm } from "../ActionForm";
import { confirmActual, publish, withdraw } from "../actions";

export const metadata: Metadata = {
  title: "Объекты",
  robots: { index: false, follow: false },
};

const MANDATE_LABEL: Record<string, string> = {
  exclusive: "эксклюзив",
  non_exclusive: "альтернатива",
};

/** Ссылка на тот же экран с заменённым одним параметром. */
function withParam(q: ObjectSearch, key: keyof ObjectSearch, value: string) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  if (value) p.set(key, value);
  else p.delete(key);
  const s = p.toString();
  return s ? `/cabinet/objects?${s}` : "/cabinet/objects";
}

export default async function ObjectsPage({
  searchParams,
}: {
  searchParams: Promise<ObjectSearch & { note?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const q = await searchParams;
  const [items, zones] = await Promise.all([searchObjects(q), objectZones()]);

  const counts = {
    mine: items.filter((o) => o.source === "mine").length,
    agency: items.filter((o) => o.source === "agency").length,
    other: items.filter((o) => o.source === "other").length,
  };
  const filtered = Object.entries(q).some(
    ([k, v]) => k !== "note" && v && String(v).trim() !== "",
  );

  return (
    <div className="wrap">
      <div className="head-row">
        <h1>Объекты</h1>
        <a className="btn primary" href="/cabinet/objects/new">Новый объект</a>
      </div>

      <p className="lead">
        Весь город, а не только своё: объект виден агентам всех агентств —
        в этом и смысл платформы. Рядом с чужим объектом видно главное о его
        договоре: тип и подписан ли он. Это ответ на вопрос «получу ли я
        комиссию, если приведу покупателя». Стартовой цены и долей чужого
        агентства здесь нет и не будет.
      </p>

      {q.note && <p className="ok-banner">{q.note}</p>}

      {/* Обычная форма GET: фильтры живут в адресе, ссылку можно отправить
          коллеге, и клиентского кода для этого не нужно вовсе. */}
      <form className="filters" method="get" action="/cabinet/objects">
        <div className="field">
          <label htmlFor="source">Источник</label>
          <select id="source" name="source" defaultValue={q.source ?? ""}>
            <option value="">Все</option>
            <option value="mine">{SOURCE_LABEL.mine}</option>
            <option value="agency">{SOURCE_LABEL.agency}</option>
            <option value="other">{SOURCE_LABEL.other}</option>
          </select>
        </div>

        {/* Внимание стоит сразу после источника, а не в конце формы:
            по этому фильтру сюда приходят со сводки, и он должен быть на
            виду, а не найден. */}
        <div className="field">
          <label htmlFor="attention">Внимание</label>
          <select id="attention" name="attention" defaultValue={q.attention ?? ""}>
            <option value="">Не важно</option>
            <option value="critical">Срочно</option>
            <option value="warning">Предупреждение</option>
            <option value="any">Есть что-то</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="deal">Сделка</label>
          <select id="deal" name="deal" defaultValue={q.deal ?? ""}>
            <option value="">Любая</option>
            <option value="sale">{DEAL_LABEL.sale}</option>
            <option value="rent">{DEAL_LABEL.rent}</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="kind">Тип</label>
          <select id="kind" name="kind" defaultValue={q.kind ?? ""}>
            <option value="">Любой</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="zone">Район</label>
          <select id="zone" name="zone" defaultValue={q.zone ?? ""}>
            <option value="">Любой</option>
            {zones.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.zone} ({z.objects})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="rooms">Комнат</label>
          <select id="rooms" name="rooms" defaultValue={q.rooms ?? ""}>
            <option value="">Любое</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
            <option value="4,5,6,7,8">4 и больше</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="price_min">Цена от</label>
          <input id="price_min" name="priceMin" type="number" min="0" step="100"
                 inputMode="numeric" defaultValue={q.priceMin ?? ""} />
        </div>

        <div className="field">
          <label htmlFor="price_max">до</label>
          <input id="price_max" name="priceMax" type="number" min="0" step="100"
                 inputMode="numeric" defaultValue={q.priceMax ?? ""} />
        </div>

        <div className="field">
          <label htmlFor="published">В каталоге</label>
          <select id="published" name="published" defaultValue={q.published ?? ""}>
            <option value="">Неважно</option>
            <option value="yes">Только опубликованные</option>
            <option value="no">Только не в каталоге</option>
          </select>
        </div>

        <div className="field wide">
          <label htmlFor="text">Адрес</label>
          <input id="text" name="text" type="search" maxLength={60}
                 placeholder="часть адреса" defaultValue={q.text ?? ""} />
        </div>

        <div className="field actions">
          <button type="submit" className="btn primary">Найти</button>
          {filtered && <a className="btn" href="/cabinet/objects">Сбросить</a>}
        </div>
      </form>

      {/* Источник отдельной строкой: это самый частый вопрос к списку, и
          ради него не стоит лезть в выпадающий список. Числа показываются
          только когда они честные — то есть когда отбор по источнику не
          включён. Иначе «Другой организации 0» означало бы не «чужих нет»,
          а «мы их сейчас не считали». */}
      <nav className="switch" aria-label="Источник объекта">
        <a href={withParam(q, "source", "")} aria-current={q.source ? undefined : "page"}>
          Все{!q.source && ` ${items.length}`}
        </a>
        {(["mine", "agency", "other"] as ObjectSource[]).map((s) => (
          <a key={s} href={withParam(q, "source", s)}
             aria-current={q.source === s ? "page" : undefined}>
            {SOURCE_LABEL[s]}{!q.source && ` ${counts[s]}`}
          </a>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="empty">
          {filtered
            ? "Под эти условия сейчас ничего нет. Это не пустой экран, а ответ: показывать нечего."
            : "Объектов пока нет. Они создаются из обращения собственника или из объявления с площадки."}
        </p>
      ) : (
        <>
          <p className="muted sm">
            {items.length} {plural(items.length, "объект", "объекта", "объектов")}
            {items.length === 300 && " — показаны первые 300, уточните условия"}
            {q.source
              ? "."
              : ". Свои первыми: по своему объекту известно больше и договориться быстрее."}
          </p>
          <div className="rows">
            {items.map((o) => (
              <ObjectRow key={o.object_id} o={o} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ObjectRow({ o }: { o: FoundObject }) {
  const mine = o.source === "mine";
  return (
    <article className="row">
      <div className="row-main">
        <h3>
          <a href={`/cabinet/objects/${o.object_id}`}>{o.address}</a>
        </h3>
        <p className="row-meta">
          {KIND_LABEL[o.kind as keyof typeof KIND_LABEL] ?? o.kind}
          {" · "}
          {DEAL_LABEL[o.deal_type as keyof typeof DEAL_LABEL] ?? o.deal_type}
          {o.rooms ? `, ${o.rooms} комн.` : ""}
          {o.area ? `, ${formatArea(o.area)}` : ""}
          {o.zone ? ` · ${o.zone}` : ""}
        </p>
        <p className="row-price">
          {formatPrice(o.price, o.currency, o.deal_type as never)}
        </p>
      </div>

      <div className="row-state">
        <p>
          <span className={`chip ${o.publication_state}`}>
            {PUBLICATION_LABEL[o.publication_state] ?? o.publication_state}
          </span>
          {o.has_mandate ? (
            o.contract_confirmed ? (
              <span className="chip ok">
                {MANDATE_LABEL[o.mandate_kind ?? ""] ?? "договор"} подтверждён
              </span>
            ) : (
              <span className="chip warn">
                {MANDATE_LABEL[o.mandate_kind ?? ""] ?? "договор"} на словах
              </span>
            )
          ) : (
            <span className="chip danger">нет действующего договора</span>
          )}
          {o.photos_count === 0 && <span className="chip warn">без фото</span>}
        </p>
        <p className="muted">
          {freshness(o.actual_at).label}
          {o.valid_to ? ` · договор до ${formatDate(o.valid_to)}` : ""}
        </p>
        {/* Причина, по которой объект попал в список внимания.
            Для `ok` и для null не рисуется ничего, и это сознательно: у
            чужого объекта (null) договор нам не виден, и зелёная галочка
            была бы утверждением, на которое у нас нет оснований. Молчание —
            правдивый ответ, когда мы не знаем. */}
        {(o.attention === "critical" || o.attention === "warning") &&
          o.attention_reasons &&
          o.attention_reasons.length > 0 && (
            <p className={o.attention === "critical" ? "alarm-text sm" : "warn-text sm"}>
              {o.attention === "critical" ? "Срочно: " : "Внимание: "}
              {o.attention_reasons.join(" · ")}
            </p>
          )}
        {/* Чей объект — это не подпись, а условие работы. Своё названо
            «веду я», чужое агентство названо по имени: агенту важно знать,
            с кем договариваться о показе. */}
        <p className="faint sm">
          {mine
            ? "веду я"
            : o.source === "agency"
              ? `${o.holder_agent_name ?? "коллега"} · моя организация`
              : `${o.holder_agent_name ?? "агент"} · ${o.agency_name ?? "другая организация"}`}
        </p>
      </div>

      {mine && (
        <div className="row-acts">
          <ActionForm action={confirmActual} label="Подтвердить актуальность">
            <input type="hidden" name="object_id" value={o.object_id} />
          </ActionForm>
          {o.publication_state === "published" ? (
            <ActionForm
              action={withdraw}
              label="Снять с каталога"
              danger
              confirm="Снять объект с публикации? В каталоге он исчезнет сразу, вместе с фотографиями."
            >
              <input type="hidden" name="object_id" value={o.object_id} />
            </ActionForm>
          ) : (
            <ActionForm action={publish} label="В каталог">
              <input type="hidden" name="object_id" value={o.object_id} />
            </ActionForm>
          )}
        </div>
      )}
    </article>
  );
}
