/**
 * Заглушка отправки писем для прогона.
 *
 * Настоящая отправка идёт через привязку Cloudflare, которой вне Worker
 * нет. Здесь письмо складывается в список — и это даёт проверить то, что
 * проверить важнее всего: что в письме ровно одна ссылка, что токен в ней
 * тот самый, и что по второму разу он не срабатывает.
 */
export type Letter = { to: string; subject: string; text: string; html?: string };

export const outbox: Letter[] = [];

export function canSendMail(): boolean {
  return true;
}

export async function sendMail(letter: Letter): Promise<void> {
  outbox.push(letter);
}

/** Достать токен из последнего письма — так же, как это сделает человек. */
export function tokenFromLastLetter(): string | null {
  const last = outbox[outbox.length - 1];
  if (!last) return null;
  const match = last.text.match(/token=([a-f0-9]+)/);
  return match ? match[1] : null;
}
