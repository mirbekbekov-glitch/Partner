/**
 * Выбор схемы фида.
 *
 * Схема — настройка канала в базе, а не ветка в коде маршрута: спецификацию
 * площадки узнают вместе с тарифом, и менять её не должно значить править
 * приложение.
 *
 * Добавление схемы: новый модуль рядом и строка здесь. Всё остальное —
 * отбор объектов, секретная ссылка, журнал обращений — общее и не меняется.
 */

import { buildPartnerFeed } from "./partner";
import { buildYandexRealty } from "./yandex-realty";
import { agencyName, type FeedItem } from "./shared";

export type { FeedItem } from "./shared";

export type FeedSettings = {
  channel: string;
  format: string;
  format_confirmed: boolean;
  contact_phone: string | null;
  ready: boolean;
  not_ready_reason: string | null;
};

export const FORMAT_LABEL: Record<string, string> = {
  partner: "наша схема",
  yandex_realty: "Яндекс.Недвижимость",
  cian: "ЦИАН",
};

export function buildFeed(
  settings: FeedSettings,
  items: FeedItem[],
  generatedAt: Date,
): string {
  switch (settings.format) {
    case "yandex_realty":
      // Готовность канала проверяет база (app.feed_settings), но проверяется
      // и здесь: собрать объявления без телефона — значит отдать площадке
      // то, по чему нельзя позвонить.
      if (!settings.contact_phone) {
        throw new Error(
          "Схеме Яндекс.Недвижимости нужен телефон для связи, а у канала он не задан.",
        );
      }
      return buildYandexRealty(items, generatedAt, {
        contactPhone: settings.contact_phone,
        agencyName: agencyName(),
      });

    case "cian":
      throw new Error(
        "Схема ЦИАН ещё не написана: её выбирают, когда площадка прислала спецификацию.",
      );

    case "partner":
    default:
      return buildPartnerFeed(settings.channel, items, generatedAt);
  }
}
