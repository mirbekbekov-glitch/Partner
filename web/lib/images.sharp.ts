/**
 * Перекодирование через sharp. Путь node: разработка, дымовые проверки,
 * обходы браузером, скрипты.
 *
 * Этот файл никогда не вычисляется в воркере: `lib/images.ts` импортирует его
 * отложенно и только в ветке node.
 */

import sharp from "sharp";
import type { Encoded, Shape } from "./images.ts";

export const name = "sharp";

export async function encode(input: Uint8Array, shape: Shape): Promise<Encoded> {
  try {
    // `failOn: "error"` — не «починить что можно», а отказаться. Файл, который
    // разбирается лишь частично, в каталог попадать не должен.
    const base = sharp(input, { failOn: "error" })
      // Поворот по EXIF делается ДО того, как EXIF выбрасывается: иначе
      // снимки, сделанные боком, останутся боком.
      .rotate();

    const sized =
      shape.kind === "fit"
        ? base.resize({
            width: shape.side,
            height: shape.side,
            fit: "inside",
            withoutEnlargement: true,
          })
        : base.resize({
            width: shape.side,
            height: shape.side,
            fit: "cover",
            // Обрезка по содержательной части кадра, а не по центру: лицо на
            // селфи чаще не в середине.
            position: "attention",
          });

    const result = await sized
      .webp({ quality: shape.quality })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  } catch {
    throw new Error("это не изображение или оно повреждено");
  }
}
