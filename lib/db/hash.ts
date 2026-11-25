import 'server-only';

/**
 * Хэши и случайные значения для входа.
 *
 * В базе лежат только SHA-256 от токенов. Утечка таблицы не даёт войти:
 * по хэшу ссылку не восстановить. Сам токен существует ровно один раз — в
 * письме или в cookie браузера.
 */

/** Случайный токен: 32 байта, в URL его можно вставить как есть. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 шестнадцатеричной строкой. */
export async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Сравнение за постоянное время.
 *
 * Обычное === выходит на первом различающемся байте, и по времени ответа
 * токен подбирается посимвольно. Здесь время не зависит от того, где
 * значения разошлись.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
