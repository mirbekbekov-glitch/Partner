import { normalizePhone } from './db/normalize';

/**
 * Ссылки на связь с агентом.
 *
 * Отдельный модуль, потому что одно и то же нужно в трёх местах: на
 * карточке объекта, на странице агента и в кабинете. Правило сборки
 * ссылки — одно, и жить оно должно в одном месте.
 *
 * Чего здесь нет: догадок. Кнопка WhatsApp появляется, только если агент
 * сам отметил, что мессенджер на номере есть; кнопка Telegram — только
 * если он вписал ник. Проверить это по номеру нельзя: ни WhatsApp, ни
 * Telegram такого не отдают. Кнопка, ведущая в пустоту, хуже отсутствия
 * кнопки: клиент решит, что агент не отвечает, и уйдёт.
 */

export type Contact = {
  phone: string | null;
  whatsapp: number;
  telegram_user: string | null;
};

export type ContactLink = { kind: 'call' | 'whatsapp' | 'telegram'; href: string; text: string };

/**
 * Международный вид номера.
 *
 * В базе номер лежит так, как его ввёл человек: «0700 11 22 33»,
 * «+996 700 112233». normalizePhone() сводит это к девяти цифрам
 * местного номера, и код страны возвращаем мы — без него ни tel:, ни
 * wa.me не сработают у звонящего из-за границы.
 */
export function phoneDigits(phone: string | null | undefined): string | null {
  const local = normalizePhone(phone);
  if (local.length === 9) return `996${local}`;
  // Номер не кыргызский или записан непривычно: отдаём как есть, если в
  // нём достаточно цифр, чтобы быть номером.
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/** Номер в том виде, в каком его читают: +996 700 11 22 33. */
export function phoneText(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone);
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('996')) {
    const n = digits.slice(3);
    return `+996 ${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * Ссылки на связь.
 *
 * `message` — готовый текст для WhatsApp. Зачем он нужен: человек
 * нажимает кнопку на странице объекта и попадает в переписку с пустым
 * полем. Адрес он уже не помнит, цену тем более, и как объяснить, откуда
 * пишет, — не знает. Пишет «здравствуйте» или закрывает. Агент получает
 * «здравствуйте» без единого признака, о каком объекте речь, и
 * переспрашивает. Готовый текст убирает оба шага.
 *
 * Текст обязан быть ЗАКОДИРОВАН: в нём пробелы, запятые, перенос строки
 * и ссылка, а незакодированный амперсанд или решётка обрежут сообщение по
 * себе — молча, без ошибки.
 *
 * Telegram готового текста не принимает: t.me/<ник> открывает переписку и
 * параметра с текстом у неё нет. Поэтому текст уходит только в WhatsApp, и
 * это не упущение, а свойство самого Telegram.
 */
export function contactLinks(contact: Contact, labels: {
  call: string; whatsapp: string; telegram: string;
}, message?: string): ContactLink[] {
  const digits = phoneDigits(contact.phone);
  const links: ContactLink[] = [];

  if (digits) {
    links.push({ kind: 'call', href: `tel:+${digits}`, text: labels.call });
    if (contact.whatsapp === 1) {
      const text = (message ?? '').trim();
      links.push({
        kind: 'whatsapp',
        href: text
          ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
          : `https://wa.me/${digits}`,
        text: labels.whatsapp,
      });
    }
  }

  if (contact.telegram_user) {
    links.push({
      kind: 'telegram',
      href: `https://t.me/${contact.telegram_user}`,
      text: labels.telegram,
    });
  }

  return links;
}
