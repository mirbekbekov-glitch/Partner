// Адаптер house.kg.
//
// Разбирает страницы объявлений и отдаёт записи в том виде, который принимает
// app.upsert_candidate(). Сети здесь нет: на вход приходит HTML, на выход —
// данные. Поэтому разбор проверяется тестами на образцах, а не прогоном по
// живому сайту.
//
// РАЗБИРАЕТСЯ JSON-LD, А НЕ ВЁРСТКА. У house.kg вёрстка собрана из
// утилитарных классов вида `text-house-text-primary-text` — они меняются при
// каждой пересборке стилей, и парсер по ним сломался бы в первую же неделю,
// продолжая при этом «работать». Зато страница объявления отдаёт
// schema.org/RealEstateListing: это опубликованный стандарт, а не внутренняя
// деталь чужого фронтенда. Оттуда берётся почти всё.
//
// Из вёрстки берётся ровно одно, чего нет в разметке стандарта: кто подал
// объявление — собственник, агентство, риелтор, агент или застройщик. Поиск
// идёт по тексту из известного списка, а не по классам, поэтому переживает
// пересборку стилей.
//
// ЧЕГО ЗДЕСЬ НЕТ: ТЕЛЕФОНА ПРОДАВЦА. На странице его нет — он за кнопкой
// «показать телефон», которая ходит в /api/, а /api/ закрыт в robots.txt
// сайта. Брать его оттуда значит нарушать прямой запрет, поэтому адаптер
// этого не делает. Иногда продавец сам вписывает номер в текст описания —
// такой номер адаптер достаёт, потому что это тот же публичный текст
// объявления. Подробности в README.

const ITEM_PATH = /^\/details\/[A-Za-z0-9-]+$/;

/** Известные обозначения автора объявления на house.kg. */
const SELLER_LABELS = [
  ["Агентство недвижимости", "agent"],
  ["Застройщик", "agent"],
  ["Риелтор", "agent"],
  ["Собственник", "owner"],
  ["Агент", "agent"],
];

const KIND_BY_SCHEMA = {
  Apartment: "flat",
  House: "house",
  SingleFamilyResidence: "house",
  Room: "room",
  LandPlot: "land",
};

const KIND_BY_WORD = [
  [/квартир/i, "flat"],
  [/комнат/i, "room"],
  [/таунхаус/i, "townhouse"],
  [/дом|коттедж/i, "house"],
  [/участок|земл/i, "land"],
  [/офис|помещени|коммерч/i, "commercial"],
  [/гараж/i, "garage"],
];

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Битый блок — не повод терять остальные.
    }
  }
  return out;
}

function decode(text) {
  return String(text ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Идентификатор объявления: последний сегмент адреса. */
export function externalIdFromUrl(url) {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const m = path.match(/^\/details\/([A-Za-z0-9-]+)$/);
  return m ? m[1] : null;
}

/** Ссылки на объявления со страницы списка. Берутся из ItemList, не из вёрстки. */
export function parseListPage(html) {
  const urls = [];
  for (const node of jsonLdBlocks(html)) {
    if (node["@type"] !== "ItemList") continue;
    for (const item of node.itemListElement ?? []) {
      if (item.url && externalIdFromUrl(item.url)) urls.push(item.url);
    }
  }
  return [...new Set(urls)];
}

function sellerKind(html) {
  // Ищется текст бейджа, а не класс: классы у house.kg генерируются сборщиком
  // стилей и меняются сами по себе, а слова — нет.
  for (const [label, kind] of SELLER_LABELS) {
    if (new RegExp(`>\\s*${label}\\s*<`).test(html)) return kind;
  }
  return "unknown";
}

/** «Продажа 3-комн. квартира: город Бишкек, 7 м-н — за 17 432 400 ⃀ — MHouse» */
function parseTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return {};
  const title = decode(m[1]).trim();

  const deal = /^\s*(аренда|сдаётся|сдается|снять)/i.test(title) ? "rent"
             : /^\s*(продажа|купить)/i.test(title) ? "sale"
             : null;

  // Адрес стоит между первым двоеточием и тире с ценой.
  const body = title.split(/\s[—–]\s/)[0] ?? "";
  const colon = body.indexOf(":");
  const address = colon >= 0 ? body.slice(colon + 1).trim() : null;

  return { deal_type: deal, address: address || null, title };
}

/** «3-комн. кв., 80 м², 9 этаж из 10» — этажность есть только здесь. */
function parseFloorsTotal(name) {
  const m = String(name ?? "").match(/этаж\s+из\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Телефон, который продавец сам вписал в текст объявления.
 * Это тот же публичный текст страницы, никакого обхода запретов. Номер за
 * кнопкой «показать телефон» живёт в /api/, и его адаптер не трогает.
 */
export function phoneFromText(text) {
  if (!text) return null;
  const m = String(text).match(/(?:\+?996|0)[\s\-()]*\d[\d\s\-()]{7,13}/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 12) return null;
  return m[0].trim();
}

function zoneFromAddress(address) {
  if (!address) return null;
  // «город Бишкек, 7 м-н» — район это то, что после города.
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

/**
 * Разбор страницы объявления. Возвращает запись для app.upsert_candidate()
 * или null, если на странице нет RealEstateListing — значит это не объявление.
 */
export function parseItemPage(html, pageUrl, { phonesFromText = true } = {}) {
  const listing = jsonLdBlocks(html).find((n) => n["@type"] === "RealEstateListing");
  if (!listing) return null;

  const url = listing.url ?? pageUrl;
  const external_id = externalIdFromUrl(url);
  if (!external_id) return null;

  const about = listing.about ?? {};
  const offer = listing.offers ?? {};
  const fromTitle = parseTitle(html);

  const kind =
    KIND_BY_SCHEMA[about["@type"]] ??
    KIND_BY_WORD.find(([re]) => re.test(listing.name ?? ""))?.[1] ??
    null;

  const area = about.floorSize?.value ?? null;
  const description = listing.description ?? null;
  const phone = phonesFromText ? phoneFromText(description) : null;

  return {
    external_id,
    url,
    title: listing.name ?? fromTitle.title ?? null,
    description,
    address: fromTitle.address ?? about.address?.addressLocality ?? null,
    zone: zoneFromAddress(fromTitle.address),
    kind,
    deal_type: fromTitle.deal_type,
    rooms: about.numberOfRooms ?? null,
    area: area === null ? null : Number(area),
    floor: about.floorLevel ?? null,
    floors_total: parseFloorsTotal(listing.name),
    price: offer.price === undefined ? null : Number(offer.price),
    currency: offer.priceCurrency ?? "KGS",
    photos_count: Array.isArray(listing.image) ? listing.image.length : 0,
    author: sellerKind(html),
    phone,
    // Хранится то, что пригодится, если разбор придётся чинить задним числом:
    // сам стандартный блок и откуда взялся телефон.
    raw: {
      listing,
      geo: about.geo ?? null,
      date_posted: listing.datePosted ?? null,
      phone_source: phone ? "описание объявления" : null,
      parsed_at: new Date().toISOString(),
    },
  };
}

/** Путь, который адаптеру разрешено запрашивать. Проверяется до запроса. */
export function isAllowedPath(path) {
  const clean = String(path).split("?")[0];
  if (clean.startsWith("/api/")) return false;
  for (const blocked of ["/login", "/profile", "/messages", "/favorites", "/settings", "/create"]) {
    if (clean === blocked || clean.startsWith(`${blocked}/`) || clean.endsWith(blocked)) {
      return false;
    }
  }
  return ITEM_PATH.test(clean) || clean.startsWith("/kupit") || clean.startsWith("/snyat");
}

export const source = "house_kg";
export const origin = "https://www.house.kg";
