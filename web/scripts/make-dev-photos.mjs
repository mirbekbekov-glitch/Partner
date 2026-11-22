// Рисует заглушки фотографий для разработки и заводит записи в базе.
//
// Настоящих фотографий у нас нет, и выдумывать их нельзя: подставить чужие
// снимки квартир в каталог значит показать объявление, которого не было.
// Поэтому заглушки выглядят как заглушки — подпись с адресом на плашке.
//
//   node scripts/make-dev-photos.mjs
//
// Файл и запись в базе появляются вместе: ключ без файла даёт битую картинку,
// файл без ключа недостижим.

import { readFileSync } from "node:fs";
import pg from "pg";
import pw from "/opt/node-tools/node_modules/playwright/index.js";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// Заглушки кладутся через тот же слой, что и настоящие снимки: иначе при
// PHOTO_STORAGE=s3 они молча уходили бы на диск, а каталог показывал бы
// битые картинки.
const { storage } = await import("../lib/storage.ts");
const store = storage();

const TONES = [
  ["#20323f", "#3d6473"],
  ["#2f2a20", "#6b5a3c"],
  ["#1f2d25", "#3f6b55"],
  ["#2b222e", "#5d4a63"],
];

const hex = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows: objects } = await client.query(
  `select o.id, o.address, o.zone, o.kind, m.listing_agent_id
     from objects o
     join mandates m on m.object_id = o.id and m.status = 'active'
    where o.publication_state = 'published'
    order by o.created_at`,
);

// Добавление фотографии поднимает actual_at: так работает инвариант 5, и это
// правильно. Но для данных разработки это побочный эффект — вся заданная в
// db/dev_seed.sql давность подтверждения обнулялась, и каталог показывал
// «подтверждено сегодня» у всех объектов. Двигать actual_at назад нельзя,
// поэтому на время засева выключается ровно один триггер. Это подготовка
// данных владельцем таблиц, а не путь приложения.
await client.query("alter table object_photos disable trigger e_photo_touches_object");

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
let made = 0;

for (const [i, obj] of objects.entries()) {
  const { rows: already } = await client.query(
    "select 1 from object_photos where object_id = $1 limit 1",
    [obj.id],
  );
  if (already.length) continue;

  const count = 1 + (i % 3);
  for (let n = 0; n < count; n++) {
    const [from, to] = TONES[(i + n) % TONES.length];
    await page.setContent(`<!doctype html>
      <body style="margin:0;height:900px;display:flex;align-items:center;
                   justify-content:center;font-family:system-ui,sans-serif;
                   background:linear-gradient(135deg,${from},${to});color:#fff">
        <div style="text-align:center;padding:40px">
          <div style="font-size:20px;opacity:.6;letter-spacing:.14em;
                      text-transform:uppercase">заглушка для разработки</div>
          <div style="font-size:46px;font-weight:600;margin:14px 0 6px">
            ${obj.address.replace(/[<>&]/g, "")}</div>
          <div style="font-size:24px;opacity:.75">${obj.zone ?? ""} · фото ${n + 1} из ${count}</div>
        </div>
      </body>`);
    const buffer = await page.screenshot({ type: "jpeg", quality: 72 });

    const key = `objects/${obj.id}/${hex()}.jpg`;
    await store.put(key, buffer, "image/jpeg");

    await client.query(
      `insert into object_photos (object_id, storage_key, sort_order, content_type,
                                  width, height, byte_size, uploaded_by_agent_id)
       values ($1, $2, $3, 'image/jpeg', 1200, 900, $4, $5)`,
      [obj.id, key, n, buffer.length, obj.listing_agent_id],
    );
    made += 1;
  }
}

await browser.close();
await client.query("alter table object_photos enable trigger e_photo_touches_object");
await client.end();
console.log(`заглушек создано: ${made}`);
