import { createServiceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

/**
 * Рассылка напоминаний о задачах. Вызывается по расписанию.
 *
 * Решение о том, что и кому напомнить, принимает база
 * (app.enqueue_due_reminders), здесь только доставка. Разделение не
 * формальное: решение проверяемо тестами, доставка — нет.
 *
 * Маршрут держит ключ service_role, то есть обходит RLS, поэтому он закрыт
 * секретом. Если секрет не задан — маршрут отказывает, а не открывается:
 * незаданный секрет это не «проверка выключена», это ошибка настройки.
 */

/** Сравнение без утечки времени: иначе секрет подбирается по задержке. */
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(request: Request): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return 'CRON_SECRET не задан — маршрут отключён, чтобы не оставить рассылку открытой';
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameSecret(token, secret)) return 'неверный секрет';

  return null;
}

async function sendTelegram(chatId: number, text: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return 'TELEGRAM_BOT_TOKEN не задан';

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
    });

    if (res.ok) return null;

    // Описание ошибки от Telegram полезно в last_error, но токен в тексте
    // ответа не встречается, поэтому записывать его безопасно.
    const detail = await res.text();
    return `Telegram ответил ${res.status}: ${detail.slice(0, 200)}`;
  } catch (e) {
    return `не удалось отправить: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`;
  }
}

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) {
    return Response.json({ error: denied }, { status: 401 });
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'ошибка настройки' },
      { status: 500 },
    );
  }

  // 1. Решаем, о чём напоминать. Идемпотентно: повторный вызов расписания
  //    дубликатов не создаёт.
  const { error: enqueueError } = await supabase.rpc('enqueue_due_reminders', {
    p_horizon: '24 hours',
  });
  if (enqueueError) {
    return Response.json({ error: enqueueError.message }, { status: 500 });
  }

  // 2. Забираем пачку. Статус 'sending' ставится при выдаче, поэтому
  //    одновременный второй вызов те же записи не возьмёт.
  const { data: batch, error: claimError } = await supabase.rpc('claim_notifications', {
    p_limit: 50,
  });
  if (claimError) {
    return Response.json({ error: claimError.message }, { status: 500 });
  }

  const rows = (batch ?? []) as {
    id: string;
    channel: string | null;
    body: string;
    telegram_id: number | null;
  }[];

  let sent = 0;
  let failed = 0;
  const reasons: Record<string, number> = {};

  for (const row of rows) {
    let error: string | null;

    if (row.channel === 'telegram' && row.telegram_id) {
      error = await sendTelegram(row.telegram_id, row.body);
    } else {
      error = 'канал доставки не определён';
    }

    if (error) {
      failed++;
      reasons[error] = (reasons[error] ?? 0) + 1;
    } else {
      sent++;
    }

    // Отчитываемся по каждой записи отдельно: падение на середине не теряет
    // уже отправленное и не отправляет повторно.
    await supabase.rpc('mark_notification', {
      p_id: row.id,
      p_ok: error === null,
      p_error: error,
    });
  }

  return Response.json({ claimed: rows.length, sent, failed, reasons });
}
