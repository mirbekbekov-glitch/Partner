import 'server-only';
import { env } from 'cloudflare:workers';

/**
 * Отправка писем через привязку Cloudflare Email Sending.
 *
 * Ни ключа, ни внешнего почтовика: письмо уходит через привязку `EMAIL`,
 * как запрос к модели уходит через `AI`. Собирать MIME не нужно — привязка
 * принимает готовые поля.
 *
 * ОТПРАВКА ОТДЕЛЕНА ОТ РЕШЕНИЯ, кому и что слать. Здесь только «положить в
 * конверт и отдать»; что написать — решают вызывающие. Та же граница, что у
 * напоминаний: что напомнить, решает база и это проверяемо тестами, а
 * отправка — нет.
 */

export type Letter = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/** Адрес отправителя. Домен обязан быть заведён в Email Sending. */
function sender(): { email: string; name: string } {
  const address = (env as unknown as { MAIL_FROM?: string }).MAIL_FROM;

  if (!address) {
    throw new Error(
      'Не задан MAIL_FROM — адрес, с которого уходят письма. Он задаётся '
      + 'секретом Worker, а его домен должен быть заведён в Email Sending.',
    );
  }
  return { email: address, name: 'Liberterra' };
}

/** Есть ли вообще чем отправлять. Позволяет сказать человеку правду, а не упасть. */
export function canSendMail(): boolean {
  const binding = (env as unknown as { EMAIL?: unknown }).EMAIL;
  const address = (env as unknown as { MAIL_FROM?: string }).MAIL_FROM;
  return Boolean(binding && address);
}

/**
 * Отправить письмо.
 *
 * Бросает, если отправка не настроена: тихо проглотить письмо со ссылкой на
 * вход — худшее из возможного, человек будет ждать его и не дождётся.
 */
export async function sendMail(letter: Letter): Promise<void> {
  const binding = (env as unknown as { EMAIL?: SendEmail }).EMAIL;

  if (!binding) {
    throw new Error(
      'Нет привязки EMAIL. Она описана в cloudflare.config.ts и требует '
      + 'домена, заведённого в Cloudflare Email Sending.',
    );
  }

  await binding.send({
    from: sender(),
    to: letter.to,
    subject: letter.subject,
    text: letter.text,
    ...(letter.html ? { html: letter.html } : {}),
  });
}
