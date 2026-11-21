import { notFound } from 'next/navigation';
import { isLang } from '@/lib/i18n';

/**
 * Проверка языка в адресе.
 *
 * Без неё /xyz открывал бы каталог с подписями языка по умолчанию: участок
 * пути динамический и принял бы любое слово. Пусть лучше будет 404 —
 * иначе у каждой страницы появилось бы бесконечное число адресов, и
 * поисковик считал бы их разными страницами с одинаковым содержимым.
 */
export default async function LangLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return children;
}
