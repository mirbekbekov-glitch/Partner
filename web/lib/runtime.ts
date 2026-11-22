/**
 * Где мы исполняемся.
 *
 * Вопрос возникает в двух разных местах — перекодирование картинок и
 * подключение к базе, — и в обоих ответ определяется рантаймом, а не
 * настройкой: sharp в workerd не грузится вовсе, привязок Cloudflare вне
 * воркера не существует. Настройка, у которой на каждом рантайме единственное
 * верное значение, годится только на то, чтобы ошибиться.
 *
 * Признак взят из рантайма: workerd сообщает о себе через `navigator.userAgent`.
 */
export function onWorkers(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

/**
 * Привязка воркера по имени, или `undefined` вне воркера.
 *
 * Импорт `cloudflare:workers` отложенный: вне воркера такого модуля нет, и
 * статический импорт сломал бы и разработку, и дымовые проверки.
 */
export async function workerBinding<T>(name: string): Promise<T | undefined> {
  if (!onWorkers()) return undefined;
  const mod = (await import("cloudflare:workers")) as {
    env: Record<string, unknown>;
  };
  return mod.env[name] as T | undefined;
}
