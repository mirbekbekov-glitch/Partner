import { permanentRedirect } from 'next/navigation';
import { DEFAULT_LANG } from '@/lib/i18n';

/**
 * Старый адрес объявления без языка.
 *
 * Такие ссылки уже разошлись по переписке, и ломать их нельзя: до появления
 * языков в пути каталог жил на /objects/<id>. Уводим на русскую версию —
 * на том языке их и отправляли. Постоянным перенаправлением, чтобы
 * поисковик перенёс накопленный вес на новый адрес.
 */
export default async function LegacyObject({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/${DEFAULT_LANG}/objects/${id}`);
}
