'use client';

import { useActionState } from 'react';
import { submitLead, type LeadError } from './lead-actions';
import { t, type Lang } from '@/lib/i18n';

/**
 * Форма заявки под карточкой объекта.
 *
 * Телефон обязателен, сообщение — нет: чем меньше полей, тем больше заявок.
 * Отправленную заявку форма не показывает повторно, иначе человек жмёт
 * второй раз, и агент думает, что интереса вдвое больше. Повтор, впрочем,
 * безвреден: база склеивает одинаковые заявки за сутки.
 */
export function LeadForm({
  lang, objectId, address,
}: {
  lang: Lang; objectId: string; address: string;
}) {
  const d = t(lang);
  // useActionState, а не обработчик onSubmit: форма работает и без
  // JavaScript, не выбрасывая телефон в адресную строку.
  const [result, action, pending] = useActionState(submitLead, null);

  if (result?.ok) {
    return (
      <div>
        <strong>{d.sent}</strong>
        <p className="key" style={{ marginTop: 6 }}>{d.sentNote(address)}</p>
      </div>
    );
  }

  const error = result && !result.ok ? result.code : null;

  return (
    <form className="stack" action={action}>
      <input type="hidden" name="object_id" value={objectId} />

      {/* Приманка для ботов: человек этого поля не видит и не заполнит.
          aria-hidden и tabIndex — чтобы и экранный диктор его не предложил. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="website">{d.honeypotLabel}</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-name">{d.yourName}</label>
        <input id="lead-name" name="name" type="text" required maxLength={120}
               autoComplete="name" placeholder={d.namePlaceholder} />
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-phone">{d.phone}</label>
        <input id="lead-phone" name="phone" type="tel" required
               autoComplete="tel" placeholder={d.phonePlaceholder} />
        <span className="key">{d.phoneNote}</span>
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-message">{d.messageLabel}</label>
        <textarea id="lead-message" name="message" rows={3} maxLength={2000}
                  placeholder={d.messagePlaceholder} />
      </div>

      <div>
        <button type="submit" disabled={pending} style={{ width: '100%', padding: 12 }}>
          {pending ? d.sending : d.sendRequest}
        </button>
      </div>

      {error ? <p className="error">{errorText(d, error)}</p> : null}
    </form>
  );
}

/** Код причины — во фразу на языке страницы. */
function errorText(d: ReturnType<typeof t>, code: LeadError): string {
  if (code === 'BAD_PHONE') return d.errPhone;
  if (code === 'BAD_INPUT') return d.errName;
  if (code === 'TOO_MANY') return d.errMany;
  if (code === 'NOT_FOUND') return d.errGone;
  return d.errGeneric;
}
