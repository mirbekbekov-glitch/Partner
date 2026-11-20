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

  return (
    <a className="card" href={`/object/${item.id}`}>
      <span className="tag">
        {KIND_LABEL[item.kind]} · {DEAL_LABEL[item.deal_type]}
        {item.zone ? ` · ${item.zone}` : ""}
      </span>
      <span className="price">
        {formatPrice(item.price, item.currency, item.deal_type)}
      </span>
      <span className="addr">{item.address}</span>
      {params.length > 0 && (
        <span className="params">
          {params.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </span>
      )}
      <span className="foot">
        <span className={`fresh-${fresh.tone}`}>{fresh.label}</span>
        <span className="tag">Подробнее</span>
      </span>
    </a>
  );
}
