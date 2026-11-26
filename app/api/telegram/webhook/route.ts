import { completeTelegramLink } from '@/lib/db/telegram';
import { explain } from '@/lib/db/report';

/**
 * Обработчик бота: сюда Telegram шлёт сообщения.
 *
 * ГЛАВНОЕ ЗДЕСЬ — проверка подлинности. Маршрут открыт в интернет, и
 * привязка Telegram не спрашивает входа: кто угодно мог бы прислать
 * «/start <чужой код>» со своим идентификатором и получить чужие
 * напоминания. Поэтому Telegram при установке обработчика получает
 * секрет и присылает его заголовком с каждым обновлением; без совпадения
 * мы не читаем тело вовсе.
 *
 * Секрет не задан — маршрут ОТКЛЮЧЁН. Открытый обработчик хуже, чем
 * неработающая привязка: неработающую видно сразу, а открытую — никогда.
 *
 * Ответ всегда 200, кроме отказа в подлинности. Telegram на любой другой
 * код повторяет обновление, и ошибка в разборе превратилась бы в
 * бесконечный поток одного и того же сообщения.
 */
export const dynamic = 'force-dynamic';

/** Сравнение за постоянное время: по времени ответа секрет не подбирается. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Update = {
  message?: {
    text?: string;
    from?: { id?: number; first_name?: string };
    chat?: { id?: number };
  };
};

async function reply(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  // Ответ бота — не главное: привязка уже состоялась. Поэтому неудача
  // отправки молчит, а не роняет обработчик: иначе Telegram повторил бы
  // обновление и привязка попыталась бы пройти второй раз.
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* молча */ }
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: 'TELEGRAM_WEBHOOK_SECRET не задан — обработчик отключён' },
      { status: 503 },
    );
  }

  const sent = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!sameSecret(sent, secret)) {
    return Response.json({ error: 'не от Telegram' }, { status: 401 });
  }

  let update: Update;
  try {
    update = await request.json() as Update;
  } catch {
    return Response.json({ ok: true });
  }

  const text = (update.message?.text ?? '').trim();
  const from = update.message?.from?.id;
  const chat = update.message?.chat?.id ?? from;

  const start = /^\/start\s+(\S+)$/.exec(text);

  if (!start || typeof from !== 'number') {
    // Любое другое сообщение боту — не наше дело. Бот служебный, а не
    // собеседник; подсказка полезнее молчания.
    if (typeof chat === 'number') {
      await reply(chat, 'Чтобы привязать Telegram, откройте ссылку из кабинета Liberterra.');
    }
    return Response.json({ ok: true });
  }

  try {
    await completeTelegramLink(start[1], from);
    if (typeof chat === 'number') {
      await reply(chat, 'Готово: напоминания о задачах и показах будут приходить сюда.');
    }
  } catch (e) {
    // Причина отказа человеку нужна: истёкший код и чужой Telegram
    // лечатся по-разному.
    if (typeof chat === 'number') await reply(chat, explain(e));
  }

  return Response.json({ ok: true });
}
