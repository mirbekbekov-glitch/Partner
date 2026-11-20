import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.SITE_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Кабинет агента индексировать нечего и незачем, а отчёты собственникам
      // открываются по личной ссылке: в индексе им не место ни при каких
      // условиях. На самой странице стоит ещё и noindex — robots.txt это
      // просьба, а не запрет.
      disallow: ["/cabinet", "/report"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
