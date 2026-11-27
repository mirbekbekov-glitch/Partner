/**
 * Отправка сообщения в Telegram.
 *
 * Вынесено из маршрута напоминаний, когда появился второй маршрут с
 * расписанием. Копия этой функции во втором файле означала бы, что
 * однажды они разойдутся: в одной появится обработка ошибки, в другой
 * нет, и сломается та, про которую забыли.
 *
 * Возвращает строку с причиной или null при успехе. Исключений не
 * бросает: неудачная доставка — обычное дело, и обрывать из-за неё
 * рассылку остальным нельзя.
 */
export async function sendTelegram(chatId: number, text: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return 'TELEGRAM_BOT_TOKEN не задан';

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
    });

    if (res.ok) return null;

    // Описание ошибки от Telegram полезно в журнале, и токен в тексте
    // ответа не встречается — записывать его безопасно.
    const detail = await res.text();
    return `Telegram ответил ${res.status}: ${detail.slice(0, 200)}`;
  } catch (e) {
    return `не удалось отправить: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`;
  }
}
