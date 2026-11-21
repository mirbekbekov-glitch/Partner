/**
 * Фид в нашей собственной схеме.
 *
 * Она так и называется — `partner-feed`, и это честное имя: выдавать свою
 * выдумку за формат площадки хуже, чем не делать ничего — интегратор на той
 * стороне потратил бы день, прежде чем понял, что схема не их.
 *
 * Годится, чтобы отдать интегратору площадки файл и сказать «вот наши
 * данные, скажите, в каком виде нужно вам».
 */

import { esc, iso, siteUrl, type FeedItem } from "./shared";

function tag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return `    <${name}>${esc(String(value))}</${name}>\n`;
}

export function buildPartnerFeed(
  channel: string,
  items: FeedItem[],
  generatedAt: Date,
): string {
  const base = siteUrl();
  const body = items
    .map((item) => {
      const photos = (item.photos ?? [])
        .map((key) => `      <photo>${esc(`${base}/photo/${key}`)}</photo>\n`)
        .join("");

      return (
        `  <object id="${esc(item.id)}">\n` +
        tag("url", `${base}/object/${item.id}`) +
        tag("kind", item.kind) +
        tag("deal-type", item.deal_type) +
        tag("address", item.address) +
        tag("zone", item.zone) +
        tag("rooms", item.rooms) +
        tag("area", item.area) +
        tag("floor", item.floor) +
        tag("floors-total", item.floors_total) +
        tag("price", item.price) +
        tag("currency", item.currency) +
        tag("description", item.description) +
        tag("published-at", iso(item.published_at)) +
        tag("actual-at", iso(item.actual_at)) +
        (photos ? `      <photos>\n${photos}      </photos>\n` : "") +
        `  </object>\n`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<partner-feed version="1" channel="${esc(channel)}" ` +
    `generated-at="${generatedAt.toISOString()}" count="${items.length}">\n` +
    body +
    `</partner-feed>\n`
  );
}
