/**
 * Заглушка cloudflare:workers.
 *
 * Внутри Worker привязки приходят из этого модуля. В прогоне их кладёт
 * сюда точка входа теста — настоящие привязки Miniflare, не поддельные:
 * база под ними живёт та же, что в продакшене, со всеми особенностями
 * SQLite.
 */
export const env: Record<string, unknown> = {};

export function setEnv(value: Record<string, unknown>): void {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, value);
}
