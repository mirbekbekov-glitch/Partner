// Дымовая проверка драйвера Supabase Storage.
//
// Хранилище нельзя проверить «на словах»: у записи нет видимого результата,
// кроме самих байтов. Поэтому здесь поднимается ЗАГЛУШКА REST-интерфейса —
// маленький HTTP-сервер, — и через неё гоняется настоящий код драйвера: с
// путём, заголовками, телом и разбором ответа.
//
// Проверяется наше: путь с бакетом и ключом, служебный ключ в заголовке,
// разрешение на перезапись, и — отдельно — что отсутствие файла это ОТВЕТ
// (null), а не ошибка, а вот отказ хранилища — ошибка, а не тишина. Тишина
// здесь означала бы «фотография не легла, но мы сказали, что легла».
//
//   node --experimental-strip-types --no-warnings scripts/smoke-storage-supabase.mjs

import { createServer } from "node:http";

let failed = 0;
function ok(condition, what) {
  console.log(`  ${condition ? "ok  " : "ПЛОХО"} ${what}`);
  if (!condition) failed += 1;
}

const seen = [];
let answer = { status: 200, body: "{}", headers: {} };

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      upsert: req.headers["x-upsert"],
      bytes: Buffer.concat(chunks),
    });
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    res.end(answer.body);
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

process.env.PHOTO_STORAGE = "supabase";
process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_KEY = "stub-service-key";
process.env.PHOTO_BUCKET = "liberterra-photos";

const { driver } = await import("../lib/storage.supabase.ts");

// --- запись -----------------------------------------------------------------
const KEY = "objects/3f0a7e1c-2b44-4a9d-8f10-5c6d7e8f9a0b/deadbeef.jpg";
await driver.put(KEY, new Uint8Array([1, 2, 3, 4]), "image/jpeg");

ok(seen.length === 1, `запрос ушёл ровно один (${seen.length})`);
const w = seen[0];
ok(w.method === "POST", `метод POST (${w.method})`);
ok(
  w.path === `/storage/v1/object/liberterra-photos/${KEY}`,
  `путь с бакетом и ключом (${w.path})`,
);
ok(w.auth === "Bearer stub-service-key", "служебный ключ ушёл в заголовке authorization");
ok(w.type === "image/jpeg", `тип содержимого из вызова (${w.type})`);
ok(w.upsert === "true", "перезапись разрешена: повторная загрузка не должна падать");
ok(w.bytes.length === 4 && w.bytes[0] === 1, `байты дошли целиком (${w.bytes.length})`);

// --- чтение ------------------------------------------------------------------
answer = {
  status: 200,
  body: "\u0001\u0002\u0003\u0004",
  headers: { "content-type": "image/jpeg", "content-length": "4" },
};
const got = await driver.read(KEY);
ok(got !== null, "файл прочитан");
ok(got?.contentType === "image/jpeg", `тип содержимого взят у хранилища (${got?.contentType})`);
ok(got?.size === 4, `размер взят у хранилища (${got?.size})`);
ok(seen[1]?.method === "GET", `чтение идёт методом GET (${seen[1]?.method})`);
ok(seen[1]?.auth === "Bearer stub-service-key", "и тоже со служебным ключом");

// --- файла нет ----------------------------------------------------------------
// Это ОТВЕТ, а не ошибка: запись в базе может пережить байты, и карточка
// обязана показать это пустым местом, а не пятисотой страницей.
answer = { status: 404, body: '{"error":"not_found"}', headers: {} };
const missing = await driver.read("objects/none/none.jpg");
ok(missing === null, "отсутствие файла — это null, а не исключение");

// --- 400, который НЕ «файла нет» ------------------------------------------------
// Supabase сообщает кодом 400 и «нет такого файла», и «ключ не годится».
// Считать оба за «нет файла» значит прятать настоящую ошибку: кривой ключ
// выглядел бы пустым местом на карточке, и никто бы не узнал, почему.
answer = {
  status: 400,
  body: '{"statusCode":"400","error":"InvalidKey","message":"Invalid key"}',
  headers: {},
};
let badKey = null;
try {
  await driver.read("objects/плохой/ключ.webp");
} catch (error) {
  badKey = error;
}
ok(badKey !== null, "негодный ключ — это ошибка, а не «файла нет»");
ok(
  badKey !== null && /отверг запрос/.test(badKey.message),
  `и ошибка говорит, что именно отвергнуто (${badKey?.message?.slice(0, 50) ?? "—"})`,
);

// А вот 400 с внутренним «не найдено» — это всё-таки ответ, а не ошибка:
// именно так Supabase отвечает на отсутствующий файл.
answer = {
  status: 400,
  body: '{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}',
  headers: {},
};
ok((await driver.read("objects/none/none.webp")) === null,
  "400 с внутренним «не найдено» — это null");

// --- отказ хранилища ------------------------------------------------------------
answer = { status: 500, body: '{"error":"internal"}', headers: {} };
let caught = null;
try {
  await driver.put(KEY, new Uint8Array([9]), "image/jpeg");
} catch (error) {
  caught = error;
}
ok(caught !== null, "отказ хранилища поднимается ошибкой, а не глотается");
ok(
  caught !== null && /не принял файл/.test(caught.message),
  `ошибка называет, что случилось (${caught?.message?.slice(0, 60) ?? "—"})`,
);

// --- удаление ---------------------------------------------------------------------
answer = { status: 200, body: "{}", headers: {} };
await driver.remove(KEY);
ok(seen.at(-1)?.method === "DELETE", `удаление идёт методом DELETE (${seen.at(-1)?.method})`);

// Удалять то, чего нет, — не ошибка: запись уже удалена.
answer = { status: 404, body: '{"error":"not_found"}', headers: {} };
let removeMissing = null;
try {
  await driver.remove("objects/none/none.jpg");
} catch (error) {
  removeMissing = error;
}
ok(removeMissing === null, "удаление отсутствующего файла проходит молча");

// --- не настроено ------------------------------------------------------------------
delete process.env.SUPABASE_SERVICE_KEY;
let noKey = null;
try {
  await driver.read(KEY);
} catch (error) {
  noKey = error;
}
ok(
  noKey !== null && /SUPABASE_SERVICE_KEY/.test(noKey.message),
  "без служебного ключа драйвер отказывается сразу",
);

stub.close();
console.log(failed === 0 ? "\nдымовая проверка хранилища пройдена" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
