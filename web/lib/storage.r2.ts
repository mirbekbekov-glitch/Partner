/**
 * Хранилище R2 через привязку. Продакшн на Cloudflare.
 *
 * Отличие от драйвера s3 не в протоколе, а в том, что привязка не ходит по
 * сети наружу и ничего не подписывает: воркер обращается к бакету внутри
 * платформы. Следствие важнее скорости: в продакшне не нужны ключи доступа к
 * бакету — нечего украсть. (Код AWS SDK из сборки при этом не исчезает:
 * сборщик оставляет его отдельным куском, который просто не загружается.)
 *
 * Бакет остаётся закрытым: публичный доступ к нему не включается. Байты
 * отдаёт приложение, а право на файл проверяется в базе на каждый запрос
 * (инвариант 11). Поэтому здесь нет ни подписанных ссылок, ни публичных
 * адресов — не «пока нет», а не должно быть.
 *
 * Файл никогда не вычисляется вне воркера: `lib/storage.ts` импортирует его
 * отложенно и только когда PHOTO_STORAGE=r2.
 */

import { workerBinding } from "./runtime.ts";
import type { Driver } from "./storage.ts";

type Bucket = {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    size?: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<void>;
};

async function bucket(): Promise<Bucket> {
  const found = await workerBinding<Bucket>("R2");
  if (!found) {
    throw new Error(
      "привязка R2 не настроена: добавьте R2: bindings.r2({ name: ... }) в cloudflare.config.ts",
    );
  }
  return found;
}

export const driver: Driver = {
  async put(key, bytes, contentType) {
    await (await bucket()).put(key, bytes, {
      httpMetadata: {
        contentType,
        // Приватно: ссылку на файл отдаёт приложение, а не хранилище.
        cacheControl: "private, max-age=300",
      },
    });
  },

  async read(key) {
    const object = await (await bucket()).get(key);
    // `null` у R2 означает ровно «такого ключа нет» — то же, что обещает
    // интерфейс. Остальные сбои привязка бросает исключением, и перехватывать
    // их здесь нельзя: отвалившийся бакет не должен выглядеть как каталог, из
    // которого молча исчезли все фотографии.
    if (!object) return null;
    return {
      body: object.body,
      size: typeof object.size === "number" ? object.size : null,
      contentType: object.httpMetadata?.contentType ?? "image/webp",
    };
  },

  async remove(key) {
    try {
      await (await bucket()).delete(key);
    } catch (error) {
      console.error(`не удалось убрать файл ${key}: ${String(error)}`);
    }
  },
};
