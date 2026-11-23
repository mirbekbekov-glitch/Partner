// Дымовая проверка отправки кода в WhatsApp.
//
// Отправку нельзя проверить «на словах»: видимого результата у неё нет, кроме
// самого сообщения. Поэтому здесь поднимается ЗАГЛУШКА Cloud API — маленький
// HTTP-сервер, — и через неё гоняется настоящий код отправки: с заголовками,
// телом и разбором ответа.
//
// Проверяется наше: путь с идентификатором номера, ключ в заголовке, форма
// шаблонного сообщения и — главное — что код подставлен ДВАЖДЫ: в тело и в
// кнопку «скопировать код». Пропуск второго даёт сообщение с кодом и
// неработающей кнопкой, и никакой ответ сервера об этом не скажет.
//
// Отдельно проверяется, что отказ становится ошибкой, а не тишиной. Тишина
// означала бы «код не ушёл, но мы сказали, что ушёл»: человек ждёт сообщение,
// которого не будет.
//
//   node --experimental-strip-types --no-warnings scripts/smoke-whatsapp.mjs

import { createServer } from "node:http";

let failed = 0;
function ok(condition, what) {
  console.log(`  ${condition ? "ok  " : "ПЛОХО"} ${what}`);
  if (!condition) failed += 1;
}

const seen = [];
let answer = { status: 200, body: { messages: [{ id: "stub" }] } };

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

process.env.WHATSAPP_API_BASE = `http://127.0.0.1:${port}`;
process.env.WHATSAPP_PROVIDER = "cloud";
process.env.WHATSAPP_TOKEN = "stub-token";
process.env.WHATSAPP_PHONE_ID = "1234567890";
process.env.WHATSAPP_TEMPLATE = "login_code";
process.env.WHATSAPP_LOCALE = "ru";

const { sendWhatsAppCode, toE164Digits } = await import("../lib/whatsapp.ts");

// --- обычная отправка -------------------------------------------------------
await sendWhatsAppCode({ to: "+996 700 123 456", code: "123456" });

ok(seen.length === 1, `запрос ушёл ровно один (${seen.length})`);
const r = seen[0];
ok(r.method === "POST", `метод POST (${r.method})`);
ok(r.path === "/1234567890/messages", `путь с идентификатором номера (${r.path})`);
ok(r.auth === "Bearer stub-token", "ключ ушёл в заголовке authorization");
ok(String(r.type).includes("application/json"), `тип содержимого json (${r.type})`);
ok(r.body?.messaging_product === "whatsapp", "messaging_product на месте");

// Номер приводится к цифрам: Cloud API не принимает ни плюса, ни пробелов, а
// агент пишет телефон так, как ему удобно.
ok(r.body?.to === "996700123456", `номер приведён к цифрам (${r.body?.to})`);
ok(toE164Digits("+996 (700) 12-34-56") === "996700123456", "приведение номера не зависит от записи");

ok(r.body?.type === "template", "сообщение шаблонное, а не свободный текст");
ok(r.body?.template?.name === "login_code", "имя шаблона из настройки");
ok(r.body?.template?.language?.code === "ru", "язык шаблона из настройки");

// Главное в этой проверке. Код обязан стоять в ДВУХ местах: в теле шаблона и
// в кнопке «скопировать код». Так устроен Cloud API, и пропуск второго даёт
// сообщение с кодом и мёртвой кнопкой — ответ сервера при этом успешный.
const parts = r.body?.template?.components ?? [];
const body = parts.find((c) => c.type === "body");
const button = parts.find((c) => c.type === "button");
ok(body?.parameters?.[0]?.text === "123456", "код подставлен в тело шаблона");
ok(button?.parameters?.[0]?.text === "123456", "и в кнопку «скопировать код» тоже");
ok(button?.sub_type === "url", `кнопка объявлена как url (${button?.sub_type}) — так её хранит WhatsApp`);
ok(button?.index === "0", `у кнопки указан индекс (${button?.index})`);

// --- отказ поставщика -------------------------------------------------------
answer = {
  status: 400,
  body: { error: { message: "Template name does not exist in the translation", code: 132001 } },
};
let caught = null;
try {
  await sendWhatsAppCode({ to: "+996700123456", code: "654321" });
} catch (error) {
  caught = error;
}
ok(caught !== null, "отказ поставщика поднимается ошибкой, а не глотается");
ok(
  caught !== null && /отказался отправлять/.test(caught.message),
  `ошибка называет причину (${caught?.message ?? "—"})`,
);
ok(
  caught !== null && /Template name does not exist/.test(caught.message),
  "жалоба поставщика доходит до нас, а не теряется",
);

// Код входа — это и есть вход, а номер — персональные данные. Ни того, ни
// другого в тексте ошибки быть не должно: ошибки читают в журналах.
ok(caught !== null && !/654321/.test(caught.message), "кода входа в тексте ошибки нет");
ok(caught !== null && !/996700123456/.test(caught.message), "и номера получателя тоже");

// --- не настроено -----------------------------------------------------------
delete process.env.WHATSAPP_TEMPLATE;
let noTemplate = null;
try {
  await sendWhatsAppCode({ to: "+996700123456", code: "111111" });
} catch (error) {
  noTemplate = error;
}
ok(
  noTemplate !== null && /WHATSAPP_TEMPLATE/.test(noTemplate.message),
  "без имени шаблона отправка отказывается сразу",
);
ok(seen.length === 2, `к поставщику без шаблона не ходили (${seen.length} запроса всего)`);

process.env.WHATSAPP_TEMPLATE = "login_code";
process.env.WHATSAPP_PROVIDER = "twilio";
let wrongProvider = null;
try {
  await sendWhatsAppCode({ to: "+996700123456", code: "222222" });
} catch (error) {
  wrongProvider = error;
}
ok(
  wrongProvider !== null && /Twilio/.test(wrongProvider.message),
  "неизвестный поставщик отказывается внятно и говорит, где заводить ветку",
);

stub.close();
console.log(failed === 0 ? "\nдымовая проверка WhatsApp пройдена" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
