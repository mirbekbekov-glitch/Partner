// Дымовая проверка хранилища.
//
// Зачем она нужна. Драйвер S3 нельзя проверить глазами: ошибка в нём
// выглядит как «фотографии не грузятся», и выяснять это на живом бакете
// дорого. Поэтому здесь поднимается ЗАГЛУШКА S3 — маленький HTTP-сервер,
// понимающий PUT, GET и DELETE объекта, — и драйвер ходит в неё по-настоящему:
// с подписью, заголовками и телом.
//
// Подпись заглушка не проверяет, и это осознанно: проверять криптографию
// AWS-библиотеки за неё незачем. Проверяется наше: тот ли метод, тот ли путь,
// тот ли тип содержимого, доходят ли байты целыми и обратно ли читаются.
//
// Отдельно проверяется, что оба драйвера ведут себя ОДИНАКОВО: один и тот же
// снимок, положенный на диск и в S3, читается одним и тем же кодом с теми же
// ответами. Иначе «работает на разработке» означало бы ровно ничего.
//
//   node scripts/smoke-storage.mjs

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};

/* ---------------------------------------------------------------------------
 * Заглушка S3
 * ------------------------------------------------------------------------ */

const bucket = new Map(); // ключ → { body, contentType }
const seen = []; // что именно спросили: метод и путь

const stub = createServer((req, res) => {
  // Путь вида /bucket/objects/<uuid>/<hex>.webp — forcePathStyle.
  const url = new URL(req.url, "http://stub");
  // Путь раскодируется: библиотека экранирует не-ASCII в ключе процентами,
  // и настоящий S3 сравнивает уже раскодированное. Без этого ключ-ловушка
  // ниже не срабатывал, и проверка «сломанное хранилище падает» молча
  // проверяла обычный 404.
  const parts = decodeURIComponent(url.pathname).replace(/^\//, "").split("/");
  const bucketName = parts.shift();
  const key = parts.join("/");
  seen.push({ method: req.method, bucket: bucketName, key });

  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bucket.set(key, {
        body: Buffer.concat(chunks),
        contentType: req.headers["content-type"] ?? "",
      });
      // Тип запоминается здесь, а не читается из бакета потом: к концу
      // проверки файлы уже удалены, и every() по пустому списку истинно
      // всегда. Первая версия именно так и «проверяла».
      seen[seen.length - 1].contentType = req.headers["content-type"] ?? "";
      res.writeHead(200, { ETag: '"stub"' }).end();
    });
    return;
  }

  if (req.method === "GET") {
    // Ключ-ловушка: так ведёт себя не пустой бакет, а сломанный.
    if (key.includes("сломано")) {
      res
        .writeHead(500, { "content-type": "application/xml" })
        .end("<Error><Code>InternalError</Code></Error>");
      return;
    }
    const found = bucket.get(key);
    if (!found) {
      // Так отвечает настоящий S3: 404 с телом NoSuchKey.
      res
        .writeHead(404, { "content-type": "application/xml" })
        .end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    res
      .writeHead(200, {
        "content-type": found.contentType,
        "content-length": String(found.body.length),
      })
      .end(found.body);
    return;
  }

  if (req.method === "DELETE") {
    bucket.delete(key);
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end();
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const port = stub.address().port;

/* ---------------------------------------------------------------------------
 * Общий снимок для обоих драйверов
 * ------------------------------------------------------------------------ */

const jpeg = await sharp({
  create: { width: 900, height: 1200, channels: 3, background: "#3d6473" },
})
  .jpeg()
  .toBuffer();

const asFile = () => new File([new Uint8Array(jpeg)], "дом.jpg", { type: "image/jpeg" });

const OBJECT = "00000000-0000-0000-0000-0000000b0001";
const AGENT = "00000000-0000-0000-0000-0000000000a1";

const dir = await mkdtemp(join(tmpdir(), "storage-smoke-"));

async function round(label, env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  // Модули читают переменные при вызове, а не при импорте, но клиент S3
  // кешируется в globalThis — для чистого прогона его надо сбросить.
  globalThis.__photoS3 = undefined;

  const { save, saveAvatar, read, remove } = await import("../lib/photos.ts");

  const stored = await save(OBJECT, asFile());
  ok(
    /^objects\/[0-9a-f-]{36}\/[0-9a-f]{32}\.webp$/.test(stored.storageKey),
    `${label}: ключ выдал сервер, а не браузер`,
  );
  ok(stored.contentType === "image/webp", `${label}: в хранилище webp`);
  ok(stored.byteSize > 0, `${label}: байты записаны`);

  const back = await read(stored.storageKey);
  ok(back !== null, `${label}: файл читается обратно`);

  const chunks = [];
  for await (const chunk of back.body) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  ok(
    bytes.length === stored.byteSize,
    `${label}: прочитано столько же байт, сколько записано`,
  );
  ok(
    bytes.subarray(0, 4).toString("latin1") === "RIFF",
    `${label}: прочитанное — это webp, а не чужой файл`,
  );

  const avatar = await saveAvatar(AGENT, asFile());
  ok(
    /^avatars\/[0-9a-f-]{36}\/[0-9a-f]{32}\.webp$/.test(avatar.storageKey),
    `${label}: аватар лежит по своему пути`,
  );
  ok(
    avatar.width === 512 && avatar.height === 512,
    `${label}: аватар квадратный 512×512`,
  );

  ok(
    (await read("objects/нет-такого/файла.webp")) === null,
    `${label}: «нет такого файла» — это ответ, а не исключение`,
  );

  await remove(stored.storageKey);
  ok(
    (await read(stored.storageKey)) === null,
    `${label}: после удаления файл не читается`,
  );

  // Повторное удаление не падает: запись в базе уже удалена, и мешать
  // уборке из-за отсутствующего файла незачем.
  await remove(stored.storageKey);
  ok(true, `${label}: повторное удаление не падает`);

  await remove(avatar.storageKey);
  return stored;
}

try {
  await round("диск", { PHOTO_STORAGE: "disk", PHOTO_DIR: dir });

  await round("S3", {
    PHOTO_STORAGE: "s3",
    PHOTO_S3_BUCKET: "liberterra-photos",
    PHOTO_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    PHOTO_S3_REGION: "auto",
    PHOTO_S3_ACCESS_KEY_ID: "stub",
    PHOTO_S3_SECRET_ACCESS_KEY: "stub",
  });

  // --- что именно улетело в хранилище ------------------------------------
  const puts = seen.filter((r) => r.method === "PUT");
  ok(puts.length === 2, "в S3 ушло ровно два PUT: объект и аватар");
  ok(
    puts.every((r) => r.bucket === "liberterra-photos"),
    "бакет взят из переменной, а не зашит в код",
  );
  ok(
    puts.some((r) => r.key.startsWith("objects/")) &&
      puts.some((r) => r.key.startsWith("avatars/")),
    "ключи в бакете разложены по папкам объектов и агентов",
  );
  ok(
    seen.some((r) => r.method === "DELETE"),
    "удаление доходит до хранилища, а не только до базы",
  );

  // Сломанное хранилище — это не «нет файла». Если бы драйвер отвечал на
  // любую ошибку пустотой, отвалившийся бакет выглядел бы как каталог, из
  // которого молча исчезли все фотографии, — и никто бы не узнал почему.
  globalThis.__photoS3 = undefined;
  const { read: readS3 } = await import("../lib/photos.ts");
  let threw = false;
  try {
    await readS3("objects/сломано/файл.webp");
  } catch {
    threw = true;
  }
  ok(threw, "ошибка хранилища поднимается, а не выдаётся за «нет файла»");
  ok(
    puts.length > 0 && puts.every((r) => r.contentType === "image/webp"),
    "тип содержимого проставлен при записи",
  );

  // --- ключ не выводит за пределы хранилища ------------------------------
  process.env.PHOTO_STORAGE = "disk";
  process.env.PHOTO_DIR = dir;
  globalThis.__photoS3 = undefined;
  const { read: readDisk } = await import("../lib/photos.ts");
  ok(
    (await readDisk("../../etc/passwd")) === null,
    "ключ с выходом за каталог не читается",
  );
} finally {
  stub.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("");
if (failed > 0) {
  console.log(`провалено проверок: ${failed}`);
  process.exit(1);
}
console.log("дымовая проверка хранилища пройдена");
