import type { DealType, ObjectKind } from "./types";

export const KIND_LABEL: Record<ObjectKind, string> = {
  flat: "Квартира",
  room: "Комната",
  house: "Дом",
  townhouse: "Таунхаус",
  land: "Участок",
  commercial: "Коммерческая",
  garage: "Гараж",
};

export const KIND_PLURAL: Record<ObjectKind, string> = {
  flat: "Квартиры",
  room: "Комнаты",
  house: "Дома",
  townhouse: "Таунхаусы",
  land: "Участки",
  commercial: "Коммерческая",
  garage: "Гаражи",
};

export const DEAL_LABEL: Record<DealType, string> = {
  sale: "Продажа",
  rent: "Аренда",
};

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function formatPrice(price: string, currency: string, deal: DealType) {
  const amount = money.format(Number(price));
  const sign = currency === "USD" ? "$" : currency === "KGS" ? "с" : currency;
  const value = currency === "USD" ? `${sign}${amount}` : `${amount} ${sign}`;
  return deal === "rent" ? `${value} в месяц` : value;
}

export function formatArea(area: string | null) {
  if (area === null) return null;
  const n = Number(area);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
  return `${text} м²`;
}

/** Для строки параметров в карточке: слово «этаж» входит в значение. */
export function formatFloor(floor: number | null, total: number | null) {
  if (floor === null) return null;
  return total ? `${floor} из ${total} этаж` : `${floor} этаж`;
}

/** Для таблицы характеристик, где слово «Этаж» уже стоит в заголовке строки. */
export function floorValue(floor: number | null, total: number | null) {
  if (floor === null) return null;
  return total ? `${floor} из ${total}` : String(floor);
}

/** Склонение существительного при числе: 1 день, 2 дня, 5 дней. */
export function plural(n: number, one: string, few: string, many: string) {
  const last = n % 10;
  const hundred = n % 100;
  if (last === 1 && hundred !== 11) return one;
  if (last >= 2 && last <= 4 && (hundred < 12 || hundred > 14)) return few;
  return many;
}

export function formatRooms(rooms: number | null) {
  if (rooms === null) return null;
  return `${rooms} ${plural(rooms, "комната", "комнаты", "комнат")}`;
}

// Принимается и Date: каталог читает строки из витрины, кабинет — объекты
// Date из драйвера pg, а считать дни надо одинаково.
export function daysSince(iso: Date | string | null): number | null {
  if (!iso) return null;
  const then = (iso instanceof Date ? iso : new Date(iso)).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/**
 * Свежесть подтверждения. Инвариант 5 держит `actual_at`: агент подтверждает,
 * что цена и фото ещё в силе. Каталог обязан показывать это покупателю —
 * иначе смысл инварианта остаётся внутренней деталью системы.
 */
export type Freshness = {
  label: string;
  tone: "fresh" | "aging" | "stale";
};

export function freshness(actualAt: Date | string | null): Freshness {
  const days = daysSince(actualAt);
  if (days === null) return { label: "Срок не указан", tone: "stale" };
  if (days <= 0) return { label: "Подтверждено сегодня", tone: "fresh" };
  if (days === 1) return { label: "Подтверждено вчера", tone: "fresh" };

  const word = plural(days, "день", "дня", "дней");
  if (days <= 7) return { label: `Подтверждено ${days} ${word} назад`, tone: "fresh" };
  if (days <= 14) return { label: `Подтверждено ${days} ${word} назад`, tone: "aging" };
  return { label: `Не подтверждалось ${days} ${word}`, tone: "stale" };
}

/** Строка запроса с одним изменённым параметром: фильтры живут в адресе. */
export function withParam(
  current: Record<string, string | string[] | undefined>,
  key: string,
  value: string | null,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first && k !== key && k !== "page") params.set(k, first);
  }
  if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/**
 * Дата из базы. Драйвер `pg` отдаёт timestamptz объектом Date, а не строкой,
 * поэтому резать её как строку нельзя — первая версия кабинета так и делала
 * и падала на странице объекта. Принимаются оба вида: из базы приходит Date,
 * из JSON — строка.
 */
// Время показывается по Бишкеку, а не по часам сервера: контейнер живёт в
// UTC, и «показ в 15:00» читался бы как 09:00. Подробности в lib/db.ts.
const BISHKEK = "Asia/Bishkek";

export function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", {
    timeZone: BISHKEK,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    timeZone: BISHKEK,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Номер телефона для человека. В базе он хранится в E.164 — это правильно для
 * сравнения и для уникальности, но «+996550221144» глазами не читается и по
 * телефону не диктуется.
 */
export function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const m = phone.match(/^\+996(\d{3})(\d{3})(\d{3})$/);
  if (m) return `+996 ${m[1]} ${m[2]} ${m[3]}`;
  const other = phone.match(/^\+(\d{1,3})(\d{3})(\d{3})(\d{2,4})$/);
  if (other) return `+${other[1]} ${other[2]} ${other[3]} ${other[4]}`;
  return phone;
}

/**
 * Доля в собственности. В базе это часть единицы (0.5000), потому что так её
 * удобно складывать и проверять. Человеку доля известна в процентах, и
 * «доля 1.0000» у единственного собственника — просто шум.
 */
export function formatShare(share: string | null): string | null {
  if (share === null) return null;
  const n = Number(share);
  if (!Number.isFinite(n) || n >= 1) return null;
  const percent = n * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1).replace(".", ",")}%`;
}

/** Состояние публикации словами. В базе это `draft`, человеку — «черновик». */
export const PUBLICATION_LABEL: Record<string, string> = {
  draft: "черновик",
  published: "в каталоге",
  withdrawn: "снят с каталога",
  archived: "в архиве",
};

/** Состояние показа словами. */
/** Структурная реакция клиента с показа (showing_outcome). */
export const OUTCOME_LABEL: Record<string, string> = {
  interested: "понравилось",
  wants_bargain: "хочет торговаться",
  thinking: "думает",
  rejected: "не подошло",
};

export const SHOWING_LABEL: Record<string, string> = {
  scheduled: "назначен",
  done: "прошёл",
  cancelled: "отменён",
  // Не «не состоялся»: отменённый показ тоже не состоялся. Инвариант 25
  // развёл эти два случая, и подпись обязана их различать.
  no_show: "клиент не пришёл",
};

/**
 * Бюджет потребности словами. Валюта у потребности не хранится: бюджеты в
 * Бишкеке называют в долларах, и выдумывать поле ради одного значения
 * незачем — когда появится вторая валюта, появится и поле.
 *
 * Жил в трёх экранах тремя копиями; третья копия и стала поводом вынести.
 */
export function formatBudget(min: string | null, max: string | null): string {
  const money = (v: string) => Number(v).toLocaleString("ru-RU");
  if (min && max) return `${money(min)} – ${money(max)} $`;
  if (max) return `до ${money(max)} $`;
  if (min) return `от ${money(min)} $`;
  return "бюджет не назван";
}
