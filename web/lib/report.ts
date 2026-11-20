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
    status: string;
    last_sync_at: string | null;
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

export const CHANNEL_STATUS_LABEL: Record<string, string> = {
  exported: "размещено",
  updated: "обновлено",
  error: "ошибка размещения",
  withdrawn: "снято",
};

export const STATE_LABEL: Record<string, string> = {
  draft: "черновик, ещё не в каталоге",
  published: "в каталоге",
  withdrawn: "снят с публикации",
};
