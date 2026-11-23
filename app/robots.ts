/**
 * robots.txt: что роботу читать, а что не его дело.
 *
 * Закрываем кабинет, вход и auth не ради секретности — их держит RLS и
 * гейт в middleware, а не эта строка. Причина в другом: робот, который
 * ходит по /auth/callback, сжигает одноразовые ссылки из писем, а пустые
 * страницы кабинета попадают в выдачу вместо объявлений.
 *
 * /api закрыт по той же причине: там приём заявок и рассылка напоминаний,
 * индексировать нечего.
 */
import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/cabinet/', '/login', '/auth/', '/api/'],
    },
    sitemap: siteUrl('/sitemap.xml'),
    host: siteUrl(),
  };
}
