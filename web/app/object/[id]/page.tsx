import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ObjectCard } from "../../components";
import { fetchObject, fetchSimilar, noteObjectView } from "@/lib/catalog";
import { headers } from "next/headers";
import {
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatPrice,
  formatRooms,
  floorValue,
  freshness,
} from "@/lib/format";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const object = await fetchObject(id);
  if (!object) return { title: "Объект не найден" };

  const price = formatPrice(object.price, object.currency, object.deal_type);
  return {
    title: `${KIND_LABEL[object.kind]}, ${object.address} — ${price}`,
    description: [
      `${DEAL_LABEL[object.deal_type]}: ${KIND_LABEL[object.kind].toLowerCase()}`,
      object.zone ? `район ${object.zone}` : null,
      formatRooms(object.rooms),
      formatArea(object.area),
      price,
    ]
      .filter(Boolean)
      .join(", "),
    alternates: { canonical: `/object/${object.id}` },
  };
}

export default async function ObjectPage({ params }: Props) {
  const { id } = await params;
  const object = await fetchObject(id);

  // Открытие отмечается ЗДЕСЬ, а не в generateMetadata: та вызывается своим
  // чередом, и считать в обеих значило бы считать каждое открытие дважды.
  // Неопубликованный объект функция не считает сама — и отвечает так же, как
  // на несуществующий, чтобы по ней нельзя было проверять существование.
  if (object) {
    await noteObjectView(id, (await headers()).get("user-agent"));
  }
  if (!object) notFound();

  const fresh = freshness(object.actual_at);
  const similar = await fetchSimilar(object);

  const specs: Array<[string, string]> = [];
  specs.push(["Тип", KIND_LABEL[object.kind]]);
  specs.push(["Сделка", DEAL_LABEL[object.deal_type]]);
  if (object.zone) specs.push(["Район", object.zone]);
  // В таблице характеристик слово уже стоит в заголовке строки, поэтому
  // здесь только число: иначе выходит «Комнат: 3 комнаты».
  if (object.rooms !== null) specs.push(["Комнат", String(object.rooms)]);
  const area = formatArea(object.area);
  if (area) specs.push(["Площадь", area]);
  const floor = floorValue(object.floor, object.floors_total);
  if (floor) specs.push(["Этаж", floor]);

  return (
    <div className="wrap">
      <a className="back" href="/">
        ← Весь каталог
      </a>

      <article className="object">
        <div>
          <h1>
            {KIND_LABEL[object.kind]}, {object.address}
          </h1>
          <p className="lede">
            {DEAL_LABEL[object.deal_type]}
            {object.zone ? ` · ${object.zone}` : ""}
          </p>
          {object.photos.length > 0 ? (
            <div
              className={`gallery${object.photos.length === 1 ? " gallery-one" : ""}`}
            >
              {object.photos.map((key, i) => (
                <img
                  key={key}
                  src={`/photo/${key}`}
                  alt={`${KIND_LABEL[object.kind]}, ${object.address}, фото ${i + 1}`}
                  loading={i === 0 ? "eager" : "lazy"}
                  decoding="async"
                />
              ))}
            </div>
          ) : (
            <div className="gallery-empty">
              Фотографий пока нет. Агент добавит их после съёмки объекта.
            </div>
          )}
          {object.description && <p className="descr">{object.description}</p>}
        </div>

        <aside className="aside">
          <span className="price">
            {formatPrice(object.price, object.currency, object.deal_type)}
          </span>
          <span className={`fresh-${fresh.tone}`}>{fresh.label}</span>

          <dl className="specs">
            {specs.map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {/* Контакты собственника в каталог не выносятся: это инвариант 4,
              и он держится политиками базы, а не решением этой страницы. */}
          <p className="note">
            Объект ведёт агент платформы. Контакты собственника не публикуются:
            связаться можно через агента, который ведёт этот объект.
          </p>
        </aside>
      </article>

      {similar.length > 0 && (
        <section className="similar">
          <h2>Похожие предложения</h2>
          <div className="grid">
            {similar.map((item) => (
              <ObjectCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
