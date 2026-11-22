/**
 * Перекодирование через привязку Images. Путь воркера.
 *
 * Привязка декодирует и кодирует байты заново — то есть делает именно то, на
 * чём держится инвариант 11, а не похожее на это. Но три вещи приходится
 * задавать явно, и каждая иначе тихо ослабила бы обещание:
 *
 *   — `metadata: "none"`. По умолчанию Images оставляет тег EXIF copyright.
 *     Один тег — мелочь, но обещано «метаданных не остаётся», и обещание
 *     должно быть правдой целиком. Разворот по EXIF при этом всё равно
 *     применяется: это сказано в документации отдельно, и именно поэтому
 *     явного `rotate` здесь нет — он бы крутил уже развёрнутое;
 *   — `anim: false`. Анимированный GIF иначе уехал бы анимированным webp:
 *     карточка объекта превратилась бы в мультик, а sharp берёт первый кадр;
 *   — `quality`. Формат без качества — это чужой выбор размера файла.
 *
 * Размеры готового файла берутся из `.info()` по готовым байтам, а не
 * вычисляются. Вычисленные совпадали бы с настоящими ровно до первого
 * расхождения в правилах округления, и расхождение было бы видно не нам, а
 * верстке каталога.
 */

import type { Encoded, Shape } from "./images.ts";

export const name = "images-binding";

type Images = {
  input(bytes: Uint8Array): {
    transform(options: Record<string, unknown>): {
      output(options: Record<string, unknown>): Promise<{ response(): Response }>;
    };
  };
  info(stream: ReadableStream): Promise<{ width?: number; height?: number }>;
};

async function binding(): Promise<Images> {
  const mod = (await import("cloudflare:workers")) as {
    env: Record<string, unknown>;
  };
  const images = mod.env.IMAGES as Images | undefined;
  if (!images) {
    throw new Error(
      "привязка IMAGES не настроена: добавьте IMAGES: bindings.images() в cloudflare.config.ts",
    );
  }
  return images;
}

export async function encode(input: Uint8Array, shape: Shape): Promise<Encoded> {
  const images = await binding();

  const transform =
    shape.kind === "fit"
      ? {
          width: shape.side,
          height: shape.side,
          // «Вписать и не увеличивать» — это ровно scale-down.
          fit: "scale-down",
          metadata: "none",
        }
      : {
          width: shape.side,
          height: shape.side,
          fit: "cover",
          // Ближайшее к sharp position: "attention" — обрезка по
          // содержательной части кадра. Алгоритмы разные, замысел один.
          gravity: "auto",
          metadata: "none",
        };

  let bytes: Uint8Array;
  try {
    const out = await images
      .input(input)
      .transform(transform)
      .output({ format: "image/webp", quality: shape.quality, anim: false });
    bytes = new Uint8Array(await out.response().arrayBuffer());
  } catch {
    throw new Error("это не изображение или оно повреждено");
  }

  // `.info()` не тарифицируется, поэтому спросить размеры дешевле, чем
  // угадать их.
  const info = await images.info(new Response(bytes).body as ReadableStream);
  if (!info.width || !info.height) {
    throw new Error("перекодирование не вернуло размеров изображения");
  }

  return { bytes, width: info.width, height: info.height };
}
