/**
 * Отправка письма.
 *
 * Один шов на всю почту: коды входа сейчас, уведомления о показах потом.
 *
 * ПОЧЕМУ HTTP API, А НЕ SMTP. Раньше здесь было написано, что SMTP выбран как
 * общий знаменатель — он есть у любого провайдера. Для приложения на Node это
 * было верно. На Cloudflare Workers — нет: исходящего SMTP там нет вовсе, и
 * никакая почтовая библиотека этого не изменит. То есть выбор сузился не по
 * вкусу, а по рантайму, и провайдер обязан иметь HTTP API.
 *
 * Первым подключён Resend. Добавить второго — это ещё одна ветка в `send()`
 * и строка в окружении; ни база, ни экраны не меняются.
 *
 * ЧТО НУЖНО ОТ ПРОВАЙДЕРА, чтобы письмо с кодом доходило, а не падало в спам:
 *
 *   — свой домен и записи SPF и DKIM в его DNS. Без них письмо с адреса вроде
 *     noreply@liberterra.kg уходит в спам у половины получателей, и человек
 *     решит, что система сломана;
 *   — обратный адрес, который кто-то читает. Письмо с кодом входа иногда
 *     получает тот, кто входа не запрашивал, и ему надо куда-то написать;
 *   — ключ отправки — секрет воркера, а не переменная в репозитории.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: ни письмо, ни адрес получателя не попадают ни в
 * журнал, ни в текст ошибки. В теме письма лежит код входа, и записать его в
 * журнал значит выдать вход тому, кто читает журналы. Адрес — персональные
 * данные. Поэтому наружу идёт только то, что сказал провайдер о САМОМ
 * запросе.
 */

export type Letter = {
  to: string;
  subject: string;
  text: string;
};

export type MailProvider = "resend";

export function mailFrom(): string {
  return process.env.MAIL_FROM ?? "";
}

function provider(): MailProvider {
  const value = process.env.MAIL_PROVIDER ?? "resend";
  if (value !== "resend") {
    throw new Error(`MAIL_PROVIDER должен быть resend, получено: ${value}`);
  }
  return value;
}

/**
 * Адрес службы провайдера. Переопределяется только для проверок: дымовая
 * проверка поднимает заглушку и гоняет через неё настоящий код отправки.
 * Проверять отправку письма «на словах» нельзя — у неё нет видимого
 * результата, кроме письма.
 */
function apiBase(): string {
  return process.env.MAIL_API_BASE ?? "https://api.resend.com";
}

export async function sendMail(letter: Letter): Promise<void> {
  const from = mailFrom();
  const key = process.env.MAIL_API_KEY;

  if (!from) {
    throw new Error(
      "Почта не настроена: нужен MAIL_FROM. Смотрите web/.env.example и web/lib/mail.ts — там написано, что требуется от провайдера.",
    );
  }
  if (!key) {
    throw new Error(
      "Почта не настроена: нужен MAIL_API_KEY. В бою это секрет воркера, а не переменная в репозитории.",
    );
  }

  switch (provider()) {
    case "resend": {
      const response = await fetch(`${apiBase()}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [letter.to],
          subject: letter.subject,
          text: letter.text,
        }),
      });

      if (!response.ok) {
        // Тело ответа — это жалоба на запрос, в нём нет ни кода, ни письма.
        // Но адрес провайдер мог повторить, поэтому берётся только поле
        // message, и то усечённое.
        let why = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body?.message) why = `${why}: ${String(body.message).slice(0, 200)}`;
        } catch {
          // Ответ без JSON — бывает у шлюзов. Кода статуса достаточно.
        }
        throw new Error(`Провайдер почты отказался отправлять письмо (${why}).`);
      }
      return;
    }
  }
}
