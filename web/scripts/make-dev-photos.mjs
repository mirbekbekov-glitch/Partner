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

// Настройки берутся СНАЧАЛА из .dev.vars и только потом из .env, и порядок
// здесь важнее, чем кажется.
//
// .dev.vars — это окружение воркера, то есть самого приложения; .env читают
// скрипты. Когда приложение переехало на Cloudflare, файлов стало два, и они
// разошлись: в .env стояло PHOTO_STORAGE=disk, в .dev.vars — s3. Заглушки
// уходили на диск, приложение искало их в S3, и каталог показывал битые
// картинки, ничего при этом не говоря.
//
// Комментарий ниже предупреждал ровно об этой беде — и был обойдён тем, что
// файл настроек появился второй. Поэтому теперь читается тот, с которым
// РАБОТАЕТ ПРИЛОЖЕНИЕ, а в конце печатается, куда легли байты.
for (const file of ["../.dev.vars", "../.env"]) {
  let text;
  try {
    text = readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    continue; // файла может не быть — это не беда, беда была бы в тишине ниже
  }
  for (const line of text.split("\n")) {
    // A-Z0-9_, а не A-Z_. Цифры в имени настройки бывают, и из-за их
    // отсутствия здесь молча пропускались PHOTO_S3_ACCESS_KEY_ID и его
    // собратья: скрипт видел PHOTO_STORAGE=s3, но не видел ключей к нему.
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
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
  // Объект ДОВОДИТСЯ до нужного числа снимков, а не пропускается, если у него
  // уже что-то есть. Иначе объект, заведённый в засеве позже, навсегда
  // оставался бы с тем, что ему досталось в первый запуск.
  const { rows: have } = await client.query(
    "select count(*)::int n, coalesce(max(sort_order), -1) last from object_photos where object_id = $1",
    [obj.id],
  );

  // До шести, а не до трёх. У настоящего объявления снимков больше трёх, и
  // при трёх печатное правило «на листе не больше четырёх» не проверялось бы
  // ни скриптом, ни глазами: нечем.
  const count = 1 + (i % 6);
  if (have[0].n >= count) continue;

  for (let n = have[0].n; n < count; n++) {
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
      [obj.id, key, have[0].last + 1 + (n - have[0].n), buffer.length, obj.listing_agent_id],
    );
    made += 1;
  }
}

await browser.close();
await client.query("alter table object_photos enable trigger e_photo_touches_object");
await client.end();
console.log(
  `заглушек создано: ${made}; хранилище: ${process.env.PHOTO_STORAGE ?? "не задано"}` +
    (process.env.PHOTO_STORAGE === "s3"
      ? ` (${process.env.PHOTO_S3_ENDPOINT ?? "адрес не задан"})`
      : ""),
);
