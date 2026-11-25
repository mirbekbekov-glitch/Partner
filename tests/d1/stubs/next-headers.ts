/**
 * Заглушка next/headers для прогона слоя доступа вне Next.
 *
 * Слой доступа узнаёт агента из cookie. В тестах cookie кладётся прямо.
 * Настоящая проверка сессии при этом НЕ обходится: токен всё равно ищется
 * в таблице sessions, то есть тест проходит тот же путь, что и браузер.
 */
let jar = new Map<string, string>();

export function setCookie(name: string, value: string | null): void {
  if (value === null) jar.delete(name); else jar.set(name, value);
}

export function resetCookies(): void {
  jar = new Map();
}

export async function cookies() {
  return {
    get(name: string) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string, value: string) { jar.set(name, value); },
    delete(name: string) { jar.delete(name); },
    getAll() { return [...jar].map(([name, value]) => ({ name, value })); },
  };
}
