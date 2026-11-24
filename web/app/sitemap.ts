import type { MetadataRoute } from "next";
import { fetchSitemapRows } from "@/lib/catalog";

/**
 * Карта сайта собирается из той же витрины, что и каталог. Значит в неё
 * физически не попадёт объект без действующего договора: инвариант 1 работает
 * и для поисковика, а не только для покупателя.
 */
// Карта собирается на сервере при каждом запросе.
//
// ПОЧЕМУ НЕ РАЗ В ЧАС, как было раньше. Хранимый на час ответ — это ISR, а
// ISR требует хранилища кэша на стороне Cloudflare (KV), которого на аккаунте
// нет. Но важнее другое: кэш страниц у нас вообще нежелателен. Один и тот же
// адрес под разными ролями возвращает разные строки — фильтрует RLS, — и
// любое хранилище, ключующее ответ по адресу, рано или поздно отдало бы
// выборку одного другому. Ровно по этой причине и Hyperdrive у нас пришлось
// бы включать с --caching-disabled (см. cloudflare.config.ts).
//
// Цена динамической сборки здесь мала: карту читают поисковые роботы, а не
// посетители, и запрос к витрине — один.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.SITE_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  const rows = await fetchSitemapRows();

  return [
    {
      url: `${base}/`,
      changeFrequency: "daily",
      priority: 1,
    },
    ...rows.map((row) => ({
      url: `${base}/object/${row.id}`,
      lastModified: row.actual_at ? new Date(row.actual_at) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}
