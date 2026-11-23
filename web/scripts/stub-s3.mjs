// Заглушка S3-совместимого хранилища, которая живёт, пока её не остановят.
//
// Зачем отдельно от smoke:storage. Та проверка гоняет драйвер в node и
// отвечает на вопрос «правильно ли драйвер говорит по протоколу». Здесь
// другой вопрос: РАБОТАЕТ ЛИ драйвер внутри воркера. `@aws-sdk/client-s3` —
// большая библиотека, написанная под Node, и в workerd она может не
// запуститься вовсе. Принимать это на веру нельзя: выяснится при
// выкладывании, то есть в худший момент.
//
// Поэтому заглушка поднимается рядом со стендом, стенд настраивается на неё,
// и по нему прогоняется обычный обход фотографий браузером. Если AWS SDK в
// воркере не работает, обход упадёт здесь, а не в бою.
//
//   node scripts/stub-s3.mjs 9000
//
// Подпись запроса не проверяется: проверять криптографию чужой библиотеки за
// неё незачем. Проверяется наше — что запросы вообще уходят и что байты
// возвращаются теми же.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9000);
const store = new Map();

function key(url) {
  // Путь вида /<бакет>/<ключ>: драйвер ходит с forcePathStyle.
  const path = decodeURIComponent(new URL(url, "http://s").pathname).replace(/^\//, "");
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(slash + 1);
}

const server = createServer((req, res) => {
  const k = key(req.url);

  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      store.set(k, {
        bytes: Buffer.concat(chunks),
        type: req.headers["content-type"] ?? "application/octet-stream",
      });
      console.log(`PUT    ${k} (${store.get(k).bytes.length} байт, ${store.get(k).type})`);
      res.writeHead(200, { ETag: '"stub"' }).end();
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const found = store.get(k);
    if (!found) {
      console.log(`GET    ${k} -> нет такого ключа`);
      res
        .writeHead(404, { "content-type": "application/xml" })
        .end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    console.log(`GET    ${k} (${found.bytes.length} байт)`);
    res.writeHead(200, {
      "content-type": found.type,
      "content-length": String(found.bytes.length),
    });
    res.end(req.method === "HEAD" ? undefined : found.bytes);
    return;
  }

  if (req.method === "DELETE") {
    console.log(`DELETE ${k} (${store.delete(k) ? "был" : "и так не было"})`);
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`заглушка S3 слушает http://127.0.0.1:${port}`);
});
