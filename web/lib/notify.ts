/**
 * Отправка уведомлений о показах.
 *
 * Та же развилка, что у кода входа (`lib/otp.ts`), и по той же причине: канал
 * — решение владельца продукта, и оно платное. До выбора работает `dev`:
 * уведомление печатается в журнал, и видно, что очередь живёт и разбирается.
 *
 * Канал у уведомлений, однако, может оказаться не тем же, что у входа.
 * Телеграм напрашивается: у агента в базе уже есть `telegram_id` (он остался
 * с тех пор, когда телеграм был ключом личности, — см. 0011_phone_identity).
 * Ему нужен только токен бота и он бесплатен, а это ровно то, чего не хватает
 * WhatsApp. Но включать его молча нельзя: бот в рабочем чате — тоже решение.
 *
 * Очередь при этом полностью в базе (инвариант 27). Здесь только три шага:
 * взять пачку, отправить, отметить. Ни одного правила о том, кому и когда,
 * в этом файле нет и быть не должно — иначе правило разошлось бы с базой.
 */

export type NotifyTransport = "dev" | "telegram" | "whatsapp";

export type Outgoing = {
  id: string;
  kind: string;
  agent_id: string;
  telegram_id: string | number | null;
  phone: string;
  body: string;
};

export function transport(): NotifyTransport {
  const value = process.env.NOTIFY_TRANSPORT ?? "dev";
  if (value !== "dev" && value !== "telegram" && value !== "whatsapp") {
    throw new Error(
      `NOTIFY_TRANSPORT должен быть dev, telegram или whatsapp, получено: ${value}`,
    );
  }
  return value;
}

/**
 * Отправить одно уведомление.
 *
 * Бросает при неудаче: отметку в очереди делает вызывающий, и ему нужно
 * отличить «ушло» от «не ушло». Текст ошибки попадёт в `last_error` и будет
 * виден агенту на экране уведомлений — поэтому он должен объяснять, а не
 * ссылаться на код.
 */
export async function sendNotification(out: Outgoing): Promise<void> {
  switch (transport()) {
    case "dev":
      console.info(`[уведомление ${out.kind}] ${out.phone}: ${out.body}`);
      return;

    case "telegram": {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        throw new Error(
          "TELEGRAM_BOT_TOKEN не задан: без токена бот не отправит ничего.",
        );
      }
      if (!out.telegram_id) {
        throw new Error(
          "у агента не записан telegram_id — он указывается в профиле кабинета",
        );
      }
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: out.telegram_id, text: out.body }),
      });
      if (!response.ok) {
        throw new Error(`телеграм ответил ${response.status}`);
      }
      return;
    }

    case "whatsapp":
      throw new Error(
        "Провайдер WhatsApp Business API не подключён. Выбор провайдера — открытое решение, см. docs/market/platform-spec.md, раздел 7.",
      );
  }
}
