import { isDbError } from '@/lib/db/errors';

/**
 * Сколько строк берёт выгрузка.
 *
 * Не «все»: ответ Worker'а собирается в памяти, и список без границы
 * однажды её исчерпает. Пять тысяч строк — это файл порядка мегабайта,
 * и до такого объёма одному агентству ещё расти.
 */
export const EXPORT_LIMIT = 5000;

/**
 * Отказ выгрузки.
 *
 * Отказ слоя доступа отдаётся как отказ, а не как пятисотая: человек без
 * сессии или без прав должен получить внятный ответ. Всё остальное —
 * ошибка сервера, и её текст наружу не уходит.
 */
export function exportFailed(e: unknown): Response {
  if (isDbError(e)) {
    const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
    return new Response(e.message, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response('Выгрузка не собралась', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
