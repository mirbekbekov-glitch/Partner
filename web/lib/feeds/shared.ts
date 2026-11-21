/** Общее для всех схем фида: экранирование, даты, адрес сайта. */

export type FeedItem = {
  id: string;
  kind: string;
  deal_type: string;
  address: string;
  zone: string | null;
  rooms: number | null;
  area: string | null;
  floor: number | null;
  floors_total: number | null;
  price: string;
  currency: string;
  photos: string[] | null;
  description: string | null;
  published_at: Date | string | null;
  actual_at: Date | string | null;
};

/** XML не прощает сырых амперсандов — и чаще всего ломается именно на адресе. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function siteUrl(): string {
  return (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function agencyName(): string {
  return process.env.AGENCY_NAME ?? "Платформа профессионалов";
}
