/**
 * Куда вести после входа.
 *
 * Берём только относительный путь: иначе ссылка вида ?next=https://… увела бы
 * человека на чужой сайт с уже выданной сессией. Схемы без слэша (javascript:)
 * тоже отсекаются, поэтому проверка именно на ведущий «/» и не «//».
 */
export function safeNext(value: string | null | undefined, fallback = '/cabinet'): string {
  if (!value) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  return value;
}
