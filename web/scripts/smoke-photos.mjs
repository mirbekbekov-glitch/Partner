// Дымовая проверка загрузки фотографий.
//
// Проверяется не разметка, а три обещания, которые экран дать не может:
//
//   — в хранилище попадает файл, созданный нами, а не присланный браузером;
//   — координаты съёмки из снимка не уезжают в каталог;
//   — файл, который не разбирается как изображение, не попадает никуда.
//
// Первое и третье — одно и то же решение (перекодирование), и именно поэтому
// его стоит проверить: если однажды кто-то «оптимизирует» запись байтов
// напрямую, молча сломаются все три.
//
//   node scripts/smoke-photos.mjs

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const dir = await mkdtemp(join(tmpdir(), "photo-smoke-"));
process.env.PHOTO_DIR = dir;

const { save, remove, MAX_UPLOAD_BYTES } = await import("../lib/photos.ts");

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};

const OBJECT = "00000000-0000-0000-0000-0000000b0001";
const file = (buffer, name, type) =>
  new File([new Uint8Array(buffer)], name, { type });

try {
  // --- снимок с телефона: большой, JPEG, с координатами ------------------
  const withGps = await sharp({
    create: { width: 4032, height: 3024, channels: 3, background: "#4a7" },
  })
    .withExif({
      IFD0: { Make: "Acme", Model: "Phone 12" },
      GPS: {
        GPSLatitude: "42/1 52/1 30/1",
        GPSLatitudeRef: "N",
        GPSLongitude: "74/1 36/1 0/1",
        GPSLongitudeRef: "E",
      },
    })
    .jpeg({ quality: 92 })
    .toBuffer();

  ok((await sharp(withGps).metadata()).exif !== undefined, "в исходном снимке EXIF есть");

  const stored = await save(OBJECT, file(withGps, "IMG_4821.JPG", "image/jpeg"));

  ok(stored.contentType === "image/webp", `формат приведён к одному (${stored.contentType})`);
  ok(stored.width <= 2000 && stored.height <= 2000,
     `размер ограничен (${stored.width}×${stored.height} из 4032×3024)`);
  ok(stored.byteSize < withGps.byteLength,
     `вес уменьшился (${Math.round(stored.byteSize / 1024)} КБ против ${Math.round(withGps.byteLength / 1024)} КБ)`);

  const saved = await readFile(join(dir, stored.storageKey));
  const meta = await sharp(saved).metadata();
  ok(meta.exif === undefined, "координаты съёмки в хранилище не попали");
  ok(!saved.includes(Buffer.from("Phone 12")), "и модель телефона тоже не попала");

  // --- ключ выдаёт сервер -------------------------------------------------
  ok(
    /^objects\/[0-9a-f-]{36}\/[0-9a-f]{32}\.webp$/.test(stored.storageKey),
    `ключ той формы, которую примет база (${stored.storageKey.slice(0, 50)}…)`,
  );
  ok(!stored.storageKey.includes("IMG_4821"), "имя файла из браузера в ключ не попало");

  const traversal = await save(
    OBJECT,
    file(withGps, "../../../etc/passwd", "image/jpeg"),
  );
  ok(
    traversal.storageKey.startsWith(`objects/${OBJECT}/`),
    "имя с выходом за каталог ничего не меняет: ключ всё равно наш",
  );

  // --- не изображение -----------------------------------------------------
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  try {
    await save(OBJECT, file(html, "photo.jpg", "image/jpeg"));
    ok(false, "документ с расширением .jpg ПРОШЁЛ как фотография");
  } catch (error) {
    ok(/не изображение/.test(error.message), `документ с расширением .jpg отклонён (${error.message})`);
  }

  // --- предел размера -----------------------------------------------------
  try {
    await save(OBJECT, {
      size: MAX_UPLOAD_BYTES + 1,
      name: "huge.jpg",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    ok(false, "файл больше предела ПРОШЁЛ");
  } catch (error) {
    ok(/больше предела/.test(error.message), "файл больше предела отклонён");
  }

  // --- уборка -------------------------------------------------------------
  await remove(stored.storageKey);
  let gone = false;
  try {
    await readFile(join(dir, stored.storageKey));
  } catch {
    gone = true;
  }
  ok(gone, "удаление убирает файл из хранилища");

  await remove(stored.storageKey);
  ok(true, "повторное удачное удаление не падает: файла и так нет");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nдымовая проверка фотографий пройдена" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
