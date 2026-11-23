/**
 * Отправка кода входа в WhatsApp.
 *
 * Один шов, как у почты в lib/mail.ts: выбор поставщика — строка в окружении,
 * ни база, ни экраны не меняются.
 *
 * ПОЧЕМУ CLOUD API ОТ META, А НЕ ОДИН ИЗ АГРЕГАТОРОВ. Cloud API — это
 * официальный и документированный интерфейс самой Meta. Часть агрегаторов
 * (например 360dialog) отдаёт его же, просто со своим адресом и ключом: такой
 * поставщик подключается сменой WHATSAPP_API_BASE, без единой строки кода. У
 * Twilio и Infobip форма запроса своя — для них понадобится вторая ветка в
 * `send()`, и писать её вслепую, не зная, кого выберут, значит писать код,
 * который, скорее всего, выбросят.
 *
 * КОД НЕЛЬЗЯ ОТПРАВИТЬ ПРОСТО ТЕКСТОМ. Сообщение с одноразовым кодом обязано
 * быть УТВЕРЖДЁННЫМ ШАБЛОНОМ категории «аутентификация». Свободный текст
 * пользователю, который нам не писал, WhatsApp не доставит вовсе. Отсюда
 * настройки WHATSAPP_TEMPLATE и WHATSAPP_LOCALE: имя шаблона и язык задаются
 * при его утверждении в Meta, и угадать их за владельца нельзя.
 *
 * КОД ПОДСТАВЛЯЕТСЯ ДВАЖДЫ, И ЭТО НЕ ОПЕЧАТКА. Один раз в тело шаблона, второй
 * — в кнопку «скопировать код». Так устроен Cloud API: кнопку объявляют как
 * OTP, но при создании шаблона WhatsApp сохраняет её как URL-кнопку, и при
 * отправке она ждёт свой параметр отдельно от тела. Пропустить второй —
 * получить сообщение с кодом и неработающей кнопкой.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: ни код, ни номер получателя не попадают ни в
 * журнал, ни в текст ошибки. Номер — персональные данные, код — это и есть
 * вход. Наружу идёт только жалоба поставщика на САМ запрос.
 *
 * ЦЕНА. Каждое сообщение с кодом платное, и тарифицируется оно отдельно даже
 * внутри суточного окна переписки. Цены Meta пересматривает ежеквартально, а
 * у агрегатора сверху своя наценка. Поэтому в коде нет ни одной цифры о
 * деньгах: любая здесь устарела бы молча. Сравнение поставщиков — в
 * docs/market/platform-spec.md, с датой.
 */

export type WhatsAppProvider = "cloud";

type Message = {
  /** Номер получателя в E.164 без плюса — так требует Cloud API. */
  to: string;
  code: string;
};

function provider(): WhatsAppProvider {
  const value = process.env.WHATSAPP_PROVIDER ?? "cloud";
  if (value !== "cloud") {
    throw new Error(
      `WHATSAPP_PROVIDER должен быть cloud, получено: ${value}. ` +
        "Агрегатор, отдающий Cloud API (например 360dialog), подключается через " +
        "WHATSAPP_API_BASE и остаётся cloud. Для Twilio или Infobip нужна своя ветка в web/lib/whatsapp.ts.",
    );
  }
  return value;
}

/**
 * Адрес службы. Переопределяется двумя способами и по двум разным причинам:
 * агрегатором, который проксирует Cloud API, и дымовой проверкой, которая
 * поднимает заглушку и гоняет через неё настоящий код отправки.
 */
function apiBase(): string {
  return process.env.WHATSAPP_API_BASE ?? "https://graph.facebook.com/v23.0";
}

/** Номер в том виде, в каком его ждёт Cloud API: только цифры. */
export function toE164Digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function sendWhatsAppCode(message: Message): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const template = process.env.WHATSAPP_TEMPLATE;
  const locale = process.env.WHATSAPP_LOCALE ?? "ru";

  if (!token) {
    throw new Error(
      "WhatsApp не настроен: нужен WHATSAPP_TOKEN. В бою это секрет воркера, а не переменная в репозитории.",
    );
  }
  if (!phoneId) {
    throw new Error(
      "WhatsApp не настроен: нужен WHATSAPP_PHONE_ID — идентификатор номера отправителя в кабинете Meta.",
    );
  }
  if (!template) {
    throw new Error(
      "WhatsApp не настроен: нужен WHATSAPP_TEMPLATE — имя утверждённого шаблона категории «аутентификация». " +
        "Свободным текстом код входа не отправляется: WhatsApp его не доставит.",
    );
  }

  switch (provider()) {
    case "cloud": {
      const response = await fetch(`${apiBase()}/${phoneId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toE164Digits(message.to),
          type: "template",
          template: {
            name: template,
            language: { code: locale },
            components: [
              { type: "body", parameters: [{ type: "text", text: message.code }] },
              {
                // Кнопка «скопировать код». sub_type url, а не otp — см. шапку.
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: message.code }],
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        let why = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { error?: { message?: string } };
          const said = body?.error?.message;
          if (said) why = `${why}: ${String(said).slice(0, 200)}`;
        } catch {
          // Ответ без JSON — бывает у шлюзов. Кода статуса достаточно.
        }
        throw new Error(`WhatsApp отказался отправлять код (${why}).`);
      }
      return;
    }
  }
}
