/**
 * Пропуск для маршрутов расписания.
 *
 * Эти маршруты ходят в базу БЕЗ сессии агента, то есть мимо проверок
 * прав, поэтому закрыты секретом. Незаданный секрет — ошибка настройки, а
 * не выключенная проверка: маршрут в таком случае ОТКАЗЫВАЕТ.
 *
 * Общий модуль, а не копия в каждом маршруте: расписаний стало два
 * (напоминания и перенос каталога), и разошедшиеся копии проверки — это
 * ровно тот случай, когда вторая тихо ослабевает.
 */

/** Сравнение без утечки времени: иначе секрет подбирается по задержке. */
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Причина отказа или null, если пропускаем. */
export function denyCron(request: Request): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return 'CRON_SECRET не задан — маршрут отключён, чтобы не оставить расписание открытым';
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameSecret(token, secret)) return 'неверный секрет';

  return null;
}
