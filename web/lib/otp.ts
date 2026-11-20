/**
 * Отправка кода входа.
 *
 * Провайдер WhatsApp Business API ещё не выбран — это решение владельца
 * продукта, и оно платное: каждое сообщение с кодом стоит денег. Поэтому
 * отправка вынесена сюда за одну функцию, и до выбора провайдера работает
 * `dev`: код печатается в журнал сервера и показывается на странице входа.
 *
 * Так кабинет можно разрабатывать и показывать целиком, не делая вид, что
 * WhatsApp уже подключён, и не пряча заглушку в середине обработчика формы.
 *
 * Подключение настоящего провайдера — это новая ветка в `send()` и строка
 * `OTP_TRANSPORT=whatsapp` в окружении. Ничего другого менять не придётся.
 */

export type OtpTransport = "dev" | "whatsapp";

export function transport(): OtpTransport {
  const value = process.env.OTP_TRANSPORT ?? "dev";
  if (value !== "dev" && value !== "whatsapp") {
    throw new Error(`OTP_TRANSPORT должен быть dev или whatsapp, получено: ${value}`);
  }
  return value;
}

/** Показывать ли код на странице. Только в режиме разработки. */
export function showsCodeOnScreen(): boolean {
  return transport() === "dev" && process.env.NODE_ENV !== "production";
}

export async function sendLoginCode(phone: string, code: string): Promise<void> {
  switch (transport()) {
    case "dev":
      // Намеренно в журнал, а не в ответ: так виден путь, которым код пойдёт
      // в бою, и видно, что сервер действительно его отправляет.
      console.info(`[вход] код для ${phone}: ${code}`);
      return;

    case "whatsapp":
      throw new Error(
        "Провайдер WhatsApp Business API не подключён. Выбор провайдера — открытое решение, см. docs/market/platform-spec.md, раздел 7. До подключения используйте OTP_TRANSPORT=dev.",
      );
  }
}
