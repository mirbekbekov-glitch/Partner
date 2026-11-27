import { contactLinks, phoneText, type Contact } from '@/lib/contact-links';
import { t, type Lang } from '@/lib/i18n';

/**
 * Связь с агентом: номер и кнопки.
 *
 * Номер показан текстом, а не спрятан за кнопкой: с ноутбука по кнопке
 * «Позвонить» звонить нечем, и человек всё равно ищет цифры, чтобы
 * набрать их на телефоне. Кнопки — для тех, у кого звонок и мессенджер
 * под рукой.
 *
 * Кнопок ровно столько, сколько агент подтвердил: WhatsApp — если
 * отметил, Telegram — если вписал ник. Проверить это по номеру нельзя,
 * и кнопка наугад обманывала бы клиента.
 */

export function ContactRow({ lang, contact }: { lang: Lang; contact: Contact }) {
  const d = t(lang);
  const links = contactLinks(contact, {
    call: d.callAgent, whatsapp: d.writeWhatsapp, telegram: d.writeTelegram,
  });

  if (links.length === 0) return null;
  const shown = phoneText(contact.phone);

  return (
    <div className="contact-row">
      {shown ? <a className="contact-num mono" href={`tel:${shown.replace(/\s/g, '')}`}>{shown}</a> : null}
      <div className="contact-links">
        {links.map((l) => (
          <a
            key={l.kind}
            className={`contact-btn is-${l.kind}`}
            href={l.href}
            // Мессенджеры открываются своим приложением или своей
            // вкладкой: уводить человека со страницы объявления, которое
            // он читает, незачем.
            target={l.kind === 'call' ? undefined : '_blank'}
            rel={l.kind === 'call' ? undefined : 'noopener noreferrer'}
          >
            {l.text}
          </a>
        ))}
      </div>
    </div>
  );
}
