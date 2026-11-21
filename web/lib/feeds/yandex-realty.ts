/**
 * Фид в схеме Яндекс.Недвижимости.
 *
 * ПОЧЕМУ ИМЕННО ОНА. Спецификации фида Лалафо у нас нет: сайт закрыт защитой
 * от роботов, в открытом доступе документации нет, партнёрскую выдают вместе
 * с тарифом. В СНГ схему Яндекс.Недвижимости принимают чаще прочих, поэтому
 * она выбрана как первое предположение — и названа предположением: у канала
 * стоит `format_confirmed = false`, и кабинет пишет об этом словами.
 *
 * ЧТО ЭТО ЗНАЧИТ НА ПРАКТИКЕ. Имена полей ниже взяты из опубликованной схемы
 * Яндекса, но проверены они не валидатором площадки, а только нашими тестами.
 * Перед первым включением фид обязан пройти валидатор той площадки, которой
 * его отдают. Если Лалафо ждёт своё — это новый модуль рядом с этим, а не
 * переписывание всего: формат канала лежит в данных.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Телефона собственника. Контакт в объявлении — агентство:
 * его номер настраивается у канала (`channel_feeds.contact_phone`), и без
 * него фид не собирается вовсе. Объявление, по которому нельзя позвонить,
 * площадке бесполезно, а нам вредно.
 */

import { esc, iso, siteUrl, type FeedItem } from "./shared";

/** Вид объекта в терминах схемы. Чего не знаем — не выдумываем. */
const CATEGORY: Record<string, string> = {
  flat: "квартира",
  room: "комната",
  house: "дом",
  townhouse: "таунхаус",
  land: "участок",
  commercial: "коммерческая недвижимость",
  garage: "гараж",
};

/** Жилая или коммерческая: схема требует это отдельным полем. */
const PROPERTY_TYPE: Record<string, string> = {
  flat: "жилая",
  room: "жилая",
  house: "жилая",
  townhouse: "жилая",
  land: "жилая",
  commercial: "коммерческая",
  garage: "коммерческая",
};

export type YandexOptions = {
  contactPhone: string;
  agencyName: string;
};

function tag(name: string, value: string | number | null | undefined, indent = 6): string {
  if (value === null || value === undefined || value === "") return "";
  return `${" ".repeat(indent)}<${name}>${esc(String(value))}</${name}>\n`;
}

export function buildYandexRealty(
  items: FeedItem[],
  generatedAt: Date,
  options: YandexOptions,
): string {
  const base = siteUrl();

  const offers = items
    .map((item) => {
      const rent = item.deal_type === "rent";
      const photos = (item.photos ?? [])
        .map((key) => tag("image", `${base}/photo/${key}`))
        .join("");

      return (
        `    <offer internal-id="${esc(item.id)}">\n` +
        tag("type", rent ? "аренда" : "продажа") +
        tag("property-type", PROPERTY_TYPE[item.kind] ?? "жилая") +
        tag("category", CATEGORY[item.kind] ?? item.kind) +
        tag("url", `${base}/object/${item.id}`) +
        // Дата подтверждения, а не создания: ради неё платформа и существует —
        // площадка может показать, когда агент последний раз подтвердил, что
        // цена и фотографии в силе.
        tag("creation-date", iso(item.actual_at ?? item.published_at)) +
        `      <location>\n` +
        tag("country", "Кыргызстан", 8) +
        tag("locality-name", "Бишкек", 8) +
        tag("sub-locality-name", item.zone, 8) +
        tag("address", item.address, 8) +
        `      </location>\n` +
        `      <sales-agent>\n` +
        tag("phone", options.contactPhone, 8) +
        tag("category", "агентство", 8) +
        tag("organization", options.agencyName, 8) +
        `      </sales-agent>\n` +
        `      <price>\n` +
        tag("value", item.price, 8) +
        tag("currency", item.currency, 8) +
        (rent ? tag("period", "месяц", 8) : "") +
        `      </price>\n` +
        (item.area
          ? `      <area>\n${tag("value", item.area, 8)}${tag("unit", "кв.м", 8)}      </area>\n`
          : "") +
        tag("rooms", item.rooms) +
        tag("floor", item.floor) +
        tag("floors-total", item.floors_total) +
        tag("description", item.description) +
        photos +
        `    </offer>\n`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">\n` +
    `  <generation-date>${generatedAt.toISOString()}</generation-date>\n` +
    offers +
    `</realty-feed>\n`
  );
}
