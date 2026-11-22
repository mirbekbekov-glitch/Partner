// Переносит фотографии и аватары из каталога на диске в настроенное
// хранилище.
//
// Нужен один раз — при переезде с диска на бакет. Ключи при этом не меняются:
// в базе они уже правильные, меняется только место, где по этим ключам лежат
// байты. Поэтому переносить можно на работающем сайте: пока файл не доехал,
// отдача вернёт 404 и напишет в журнал, что база и хранилище разошлись.
//
//   PHOTO_DIR=./var/photos \
//   PHOTO_STORAGE=s3 PHOTO_S3_BUCKET=... PHOTO_S3_ENDPOINT=... \
//   PHOTO_S3_ACCESS_KEY_ID=... PHOTO_S3_SECRET_ACCESS_KEY=... \
//   node --experimental-strip-types scripts/photos-to-storage.mjs
//
// Повторный запуск безопасен: уже перенесённое перезаписывается теми же
// байтами. Сверка идёт по базе, а не по обходу каталога: файл, на который
// нет записи, переносить незачем — он и так недостижим.

import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const FROM = process.env.PHOTO_DIR;
if (!FROM) throw new Error("PHOTO_DIR не задан: откуда переносить?");

const kind = process.env.PHOTO_STORAGE ?? "disk";
if (kind === "disk") {
  throw new Error(
    "PHOTO_STORAGE=disk: переносить некуда. Задайте PHOTO_STORAGE=s3 и доступы к бакету.",
  );
}

const { storage } = await import("../lib/storage.ts");
const target = storage();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Тип содержимого берётся из базы для фотографий объектов: там он записан при
// загрузке. У аватара он один по определению схемы — ключ кончается на .webp.
const { rows } = await client.query(`
  select storage_key as key, content_type as type from object_photos
  union all
  select avatar_key, 'image/webp' from agents where avatar_key is not null
`);
await client.end();

let moved = 0;
let missing = 0;
const gone = [];

for (const row of rows) {
  const path = join(normalize(FROM), normalize(row.key));
  if (!path.startsWith(normalize(FROM))) {
    // Ключ из базы ограничен проверкой схемы, но полагаться на одну проверку
    // не стоит: этот скрипт читает файлы по имени.
    console.error(`ключ ${row.key} выводит за пределы каталога — пропущен`);
    missing += 1;
    continue;
  }

  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    missing += 1;
    gone.push(row.key);
    continue;
  }

  await target.put(row.key, bytes, row.type ?? "image/webp");
  moved += 1;
}

console.log(`перенесено: ${moved}`);
if (missing > 0) {
  console.log(`не найдено файлов: ${missing}`);
  // Это не обязательно поломка: запись могла пережить файл, и тогда отдача
  // уже сейчас отвечает 404. Но знать об этом надо, а не узнавать от клиента.
  for (const key of gone.slice(0, 20)) console.log(`  нет файла: ${key}`);
  if (gone.length > 20) console.log(`  …и ещё ${gone.length - 20}`);
  process.exit(1);
}
