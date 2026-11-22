// Дымовая проверка отправки почты.
//
// Отправку письма нельзя проверить «на словах»: видимого результата у неё
// нет, кроме самого письма. Поэтому здесь поднимается ЗАГЛУШКА провайдера —
// маленький HTTP-сервер, — и через неё гоняется настоящий код отправки: с
// заголовками, телом и разбором ответа.
//
// Проверяется наше: метод, путь, ключ в заголовке, тип содержимого, поля
// письма, и — отдельно — что отказ провайдера становится ошибкой, а не
// тишиной. Тишина здесь означала бы «код входа не ушёл, но мы сказали, что
// ушёл»: человек ждёт письмо, которого не будет.
//
//   node --experimental-strip-types --no-warnings scripts/smoke-mail.mjs

import { createServer } from "node:http";

let failed = 0;
function ok(condition, what) {
  console.log(`  ${condition ? "ok  " : "ПЛОХО"} ${what}`);
  if (!condition) failed += 1;
}

const seen = [];
let answer = { status: 200, body: { id: "stub" } };

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    seen.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      body,
    });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

process.env.MAIL_API_BASE = `http://127.0.0.1:${port}`;
process.env.MAIL_PROVIDER = "resend";
process.env.MAIL_FROM = "Liberterra <noreply@example.kg>";
process.env.MAIL_API_KEY = "stub-key";

const { sendMail } = await import("../lib/mail.ts");

// --- обычная отправка -------------------------------------------------------
await sendMail({ to: "agent@example.kg", subject: "Код входа: 123456", text: "Код: 123456" });

ok(seen.length === 1, `запрос ушёл ровно один (${seen.length})`);
const r = seen[0];
ok(r.method === "POST", `метод POST (${r.method})`);
ok(r.path === "/emails", `путь /emails (${r.path})`);
ok(r.auth === "Bearer stub-key", "ключ ушёл в заголовке authorization");
ok(String(r.type).includes("application/json"), `тип содержимого json (${r.type})`);
ok(r.body?.from === "Liberterra <noreply@example.kg>", "обратный адрес взят из MAIL_FROM");
ok(Array.isArray(r.body?.to) && r.body.to[0] === "agent@example.kg", "получатель на месте");
ok(r.body?.subject === "Код входа: 123456", "тема на месте");
ok(r.body?.text === "Код: 123456", "текст на месте");

// --- отказ провайдера -------------------------------------------------------
answer = { status: 422, body: { message: "domain is not verified", name: "validation_error" } };
let caught = null;
try {
  await sendMail({ to: "agent@example.kg", subject: "Код входа: 654321", text: "Код: 654321" });
} catch (error) {
  caught = error;
}
ok(caught !== null, "отказ провайдера поднимается ошибкой, а не глотается");
ok(
  caught !== null && /отказался отправлять/.test(caught.message),
  `ошибка называет причину (${caught?.message ?? "—"})`,
);
ok(
  caught !== null && /domain is not verified/.test(caught.message),
  "жалоба провайдера доходит до нас, а не теряется",
);
// Код входа лежит в теме письма. Если он попадёт в текст ошибки, его увидит
// тот, кто читает журналы, — то есть вход достанется не тому.
ok(
  caught !== null && !/654321/.test(caught.message),
  "кода входа в тексте ошибки нет",
);

// --- не настроено -----------------------------------------------------------
delete process.env.MAIL_API_KEY;
let noKey = null;
try {
  await sendMail({ to: "agent@example.kg", subject: "Код", text: "Код" });
} catch (error) {
  noKey = error;
}
ok(noKey !== null && /MAIL_API_KEY/.test(noKey.message), "без ключа отправка отказывается сразу");
ok(seen.length === 2, `к провайдеру без ключа не ходили (${seen.length} запроса всего)`);

stub.close();
console.log(failed === 0 ? "\nдымовая проверка почты пройдена" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
