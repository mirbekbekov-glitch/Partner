import type { MetadataRoute } from "next";
import { fetchSitemapRows } from "@/lib/catalog";

/**
 * Карта сайта собирается из той же витрины, что и каталог. Значит в неё
 * физически не попадёт объект без действующего договора: инвариант 1 работает
 * и для поисковика, а не только для покупателя.
 */
// Карта собирается на сервере и обновляется раз в час: каталог меняется
// каждый день, а статическая карта осталась бы с датой сборки.
export const revalidate = 3600;

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
