/** Строка публичной витрины `public_catalog_v`. Ни контактов, ни комиссии. */
export type CatalogObject = {
  id: string;
  kind: ObjectKind;
  deal_type: DealType;
  address: string;
  zone: string | null;
  rooms: number | null;
  area: string | null;
  floor: number | null;
  floors_total: number | null;
  price: string;
  currency: string;
  photos: string[];
  description: string | null;
  published_at: string | null;
  actual_at: string | null;
};

export type DealType = "sale" | "rent";

export type ObjectKind =
  | "flat"
  | "room"
  | "house"
  | "townhouse"
  | "land"
  | "commercial"
  | "garage";

export type CatalogFilters = {
  deal: DealType | null;
  kind: ObjectKind | null;
  zone: string | null;
  rooms: number | null;
  priceMin: number | null;
  priceMax: number | null;
  sort: SortKey;
  page: number;
};

export type SortKey = "fresh" | "price_asc" | "price_desc" | "area_desc";
