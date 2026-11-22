import type { CatalogObject } from "@/lib/types";
import {
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatFloor,
  formatPrice,
  formatRooms,
  freshness,
} from "@/lib/format";

export function ObjectCard({ item }: { item: CatalogObject }) {
  const fresh = freshness(item.actual_at);
  const params = [
    formatRooms(item.rooms),
    formatArea(item.area),
    formatFloor(item.floor, item.floors_total),
  ].filter((x): x is string => x !== null);

  const cover = item.photos[0];

  return (
    <a className="card" href={`/object/${item.id}`}>
      {cover ? (
        <img
          className="cover"
          src={`/photo/${cover}`}
          alt={`${KIND_LABEL[item.kind]}, ${item.address}`}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="cover cover-empty">Фотографий пока нет</span>
      )}
      {/* Тип сделки — красной плашкой на снимке, как в макете: это первое,
          что человек ищет глазами в сетке карточек. */}
      <span className="deal-badge">{DEAL_LABEL[item.deal_type]}</span>

      <span className="price-row">
        <span className="price">
          {formatPrice(item.price, item.currency, item.deal_type)}
        </span>
        <span className={`fresh-dot fresh-${fresh.tone}`}>{fresh.label}</span>
      </span>
      <span className="addr">{item.address}</span>

      {/* Параметры серыми плашками, а не строкой через точку: так они
          читаются как набор фактов, а не как предложение. */}
      <span className="params">
        <span>{KIND_LABEL[item.kind]}</span>
        {item.zone && <span>{item.zone}</span>}
        {params.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </span>
    </a>
  );
}
