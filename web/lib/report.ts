import { asReportRole } from "./db";
import type { DealType, ObjectKind } from "./types";

export type ShowingOutcome =
  | "interested"
  | "wants_bargain"
  | "thinking"
  | "rejected";

/** Документ, который отдаёт `app.owner_report()`. Собирается целиком в базе. */
export type OwnerReport = {
  object: {
    address: string;
    zone: string | null;
    kind: ObjectKind;
    deal_type: DealType;
    rooms: number | null;
    area: string | null;
    floor: number | null;
    floors_total: number | null;
    price: string;
    currency: string;
    publication_state: "draft" | "published" | "withdrawn";
    published_at: string | null;
    actual_at: string | null;
  };
  channels: Array<{
    channel: string;
    /** Отдаём ли мы объект в этот канал прямо сейчас (инвариант 28). */
    in_feed: boolean;
    /** Когда по ссылке канала последний раз приходили за фидом. */
    fetched_at: string | null;
    has_error: boolean;
  }>;
  showings: {
    scheduled: number;
    done: number;
    cancelled: number;
    last_done_at: string | null;
    outcomes: Partial<Record<ShowingOutcome, number>>;
  };
  interest: { matches: number; rejected: number };
  price_changes: { count: number; last_at: string | null };
  report: { generated_at: string; views: number };
};

/**
 * Отчёт по токену из ссылки.
 *
 * Токен в запрос не подставляется строкой и нигде не разбирается на стороне
 * приложения: проверку срока, отзыва и принадлежности делает функция в базе.
 * Поэтому страница не может по ошибке показать отозванный отчёт — ей просто
 * нечего показать, функция вернёт null.
 */
export async function fetchOwnerReport(
  token: string,
): Promise<OwnerReport | null> {
  return asReportRole(async (client) => {
    const { rows } = await client.query<{ report: OwnerReport | null }>(
      "select app.owner_report($1) as report",
      [token],
    );
    return rows[0]?.report ?? null;
  });
}

export const OUTCOME_LABEL: Record<ShowingOutcome, string> = {
  interested: "заинтересовались",
  wants_bargain: "просят торг",
  thinking: "думают",
  rejected: "отказались",
};

export const CHANNEL_LABEL: Record<string, string> = {
  site: "Сайт платформы",
  mini_app: "Мини-приложение",
  lalafo: "Lalafo",
  house_kg: "House.kg",
};

/**
 * Инвариант 28 убрал из отчёта слова «размещено» и «обновлено»: площадка не
 * сообщает нам, что она разместила объект, и говорить за неё значит врать
 * собственнику. Остались две вещи, которые мы знаем: отдаём ли мы объект
 * туда и приходили ли оттуда за фидом.
 */
export const IN_FEED_LABEL: Record<string, string> = {
  yes: "отдаём на площадку",
  no: "не отдаём",
};

export const STATE_LABEL: Record<string, string> = {
  draft: "черновик, ещё не в каталоге",
  published: "в каталоге",
  withdrawn: "снят с публикации",
};

// ---------------------------------------------------------------------------
// Кабинет собственника
// ---------------------------------------------------------------------------

/** Документ, который отдаёт `app.owner_cabinet()`. Собирается целиком в базе. */
export type OwnerCabinet = {
  owner: { name: string; generated_at: string };
  objects: Array<{
    id: string;
    address: string;
    kind: ObjectKind;
    deal_type: DealType;
    price: string;
    currency: string;
    rooms: number | null;
    area: string | null;
    publication_state: "draft" | "published" | "withdrawn";
    actual_at: string | null;
    paused: boolean;
    pause_reason: string | null;
    paused_by: "owner" | "agent" | "admin" | null;
    showings_done: number;
    /** Время ближайших показов. Ни имён, ни телефонов: инвариант 4. */
    showings_ahead: string[];
    channels: Array<{ channel: string; in_feed: boolean }>;
  }>;
};

export async function fetchOwnerCabinet(
  token: string,
): Promise<OwnerCabinet | null> {
  return asReportRole(async (client) => {
    const { rows } = await client.query<{ cabinet: OwnerCabinet | null }>(
      "select app.owner_cabinet($1) as cabinet",
      [token],
    );
    return rows[0]?.cabinet ?? null;
  });
}

/**
 * Приостановить или возобновить показы.
 *
 * Отказ приходит ответом, а не исключением: собственнику пятисотая страница
 * не объясняет ничего, а «это не ваш объект» объясняет всё.
 */
export async function setOwnerPause(
  token: string,
  objectId: string,
  paused: boolean,
  reason: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  return asReportRole(async (client) => {
    const { rows } = await client.query<{ result: { ok: boolean; reason?: string } }>(
      "select app.owner_pause($1, $2, $3, $4) as result",
      [token, objectId, paused, reason],
    );
    return rows[0]?.result ?? { ok: false, reason: "не удалось выполнить" };
  });
}
