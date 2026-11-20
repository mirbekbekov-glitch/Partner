'use client';

import { useState } from 'react';
import { submitLead } from './lead-actions';

/**
 * Форма заявки под карточкой объекта.
 *
 * Телефон обязателен, сообщение — нет: чем меньше полей, тем больше заявок.
 * Отправленную заявку форма не показывает повторно, иначе человек жмёт
 * второй раз, и агент думает, что интереса вдвое больше. Повтор, впрочем,
 * безвреден: база склеивает одинаковые заявки за сутки.
 */
export function LeadForm({ objectId, address }: { objectId: string; address: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'sent') {
    return (
      <div className="card">
        <strong>Заявка отправлена.</strong>
        <p className="key" style={{ marginTop: 6 }}>
          Агент, который ведёт «{address}», свяжется с вами по оставленному номеру.
        </p>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setState('sending');
    const result = await submitLead(new FormData(e.currentTarget));
    if (result.ok) {
      setState('sent');
    } else {
      setError(result.error);
      setState('idle');
    }
  }

  return (
    <form className="card stack" onSubmit={onSubmit}>
      <input type="hidden" name="object_id" value={objectId} />

      {/* Приманка для ботов: человек этого поля не видит и не заполнит.
          aria-hidden и tabIndex — чтобы и экранный диктор его не предложил. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="website">Сайт</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-name">Как вас зовут</label>
        <input id="lead-name" name="name" type="text" required maxLength={120}
               autoComplete="name" placeholder="Азамат" />
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-phone">Телефон</label>
        <input id="lead-phone" name="phone" type="tel" required
               autoComplete="tel" placeholder="+996 700 00 00 00" />
        <span className="key">По нему с вами свяжется агент. Больше никому он не виден.</span>
      </div>

      <div className="field">
        <label className="key" htmlFor="lead-message">Вопрос или удобное время (необязательно)</label>
        <textarea id="lead-message" name="message" rows={3} maxLength={2000}
                  placeholder="Можно посмотреть в субботу днём?" />
      </div>

      <div>
        <button type="submit" disabled={state === 'sending'}>
          {state === 'sending' ? 'Отправляем…' : 'Оставить заявку'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
