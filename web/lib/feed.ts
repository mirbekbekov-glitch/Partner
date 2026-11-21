/**
 * Фид для площадки.
 *
 * Площадки забирают объявления фидом: агентство даёт ссылку, площадка ходит
 * по ней сама. Так это устроено и у «Лалафо», и у house.kg, и у всех, кто
 * работает с агентствами по тарифу. Своего API для размещения они не
 * публикуют, а постить через их сайт роботом — это писать в чужую систему
 * мимо её правил; мы так не делаем.
 *
 * ФОРМАТ. Здесь наша собственная схема, и она так и названа — `partner-feed`.
 * Выдавать нашу выдумку за формат площадки было бы хуже, чем не делать
 * ничего: интегратор на той стороне потратил бы день, прежде чем понял, что
 * схема не их. Настоящее отображение в их поля — это небольшой адаптер
 * рядом с этим файлом, и писать его надо по ИХ спецификации, которую
 * агентство получает вместе с тарифом.
 *
 * ЧЕГО В ФИДЕ НЕТ. Телефонов собственников. Не потому, что мы их вырезаем,
 * а потому, что фид строится из `public_catalog_v`, где их нет вовсе
 * (инвариант 4). Контакт для площадки — контакт агентства.
 */

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
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return `    <${name}>${esc(String(value))}</${name}>\n`;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function siteUrl(): string {
  return (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Собирает фид.
 *
 * `generatedAt` передаётся снаружи, а не берётся здесь: тогда функция
 * чистая, и её можно проверить, не подменяя часы.
 */
export function buildFeed(
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
        // Дата подтверждения — то, ради чего платформа существует: площадка
        // может показать, что цена и фотографии проверены агентом тогда-то.
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
