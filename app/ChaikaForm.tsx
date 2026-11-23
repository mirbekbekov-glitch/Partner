'use client';

/**
 * Форма заявки с печатного QR-кода «Чайка».
 *
 * Не та же, что на /request: там спрашивают, ЧТО человек ищет, — направление,
 * тип жилья, комнаты, район, бюджет. Здесь объект уже известен, и спрашивать
 * про район бессмысленно. Остаётся имя, телефон и вопрос.
 *
 * Обязателен только телефон. Человек стоит у баннера с телефоном в руке, и
 * каждое лишнее поле — это потерянная заявка.
 */

import { useActionState } from 'react';
import { submitRequest, type RequestResult } from './request-actions';

const ERRORS: Record<string, string> = {
  BAD_PHONE: 'Проверьте номер: похоже, в нём опечатка.',
  BAD_INPUT: 'Слишком длинный текст — сократите, пожалуйста.',
  TOO_MANY: 'С этого номера уже есть заявки. Мы свяжемся, дайте нам немного времени.',
  OTHER: 'Не удалось отправить. Попробуйте ещё раз или позвоните нам.',
};

export function ChaikaForm({ source }: { source: string }) {
  const [state, formAction, pending] = useActionState<RequestResult | null, FormData>(
    submitRequest,
    null,
  );

  if (state?.ok) {
    return (
      <div className="sent-plate">
        <strong>Заявка принята.</strong>
        <p className="note">
          Агент перезвонит и пришлёт видеообзор, расчёт доходности и условия
          просмотра.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack">
      {/* Метка источника: по ней в кабинете видно, что заявка пришла с QR-кода
          на «Чайке», а не из каталога. Иначе понять, сработала ли печатная
          реклама, нельзя. */}
      <input type="hidden" name="source" value={source} />

      {/* Ловушка для роботов: человек этого поля не видит и не заполняет.
          Класс honeypot прячет его — тот же приём, что на /request. */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="ch-website">Не заполняйте это поле</label>
        <input id="ch-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="field">
        <label className="key" htmlFor="ch-phone">Телефон</label>
        <input id="ch-phone" name="phone" type="tel" required
               inputMode="tel" autoComplete="tel" placeholder="+996 700 00 00 00" />
      </div>

      <div className="field">
        <label className="key" htmlFor="ch-name">Как к вам обращаться</label>
        <input id="ch-name" name="name" type="text" autoComplete="name"
               placeholder="Необязательно" />
      </div>

      <div className="field">
        <label className="key" htmlFor="ch-wishes">Вопрос или пожелание</label>
        <textarea id="ch-wishes" name="wishes" rows={3}
                  placeholder="Необязательно. Например: когда можно посмотреть" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Отправляем…' : 'Получить видеообзор и условия'}
        </button>
      </div>

      {state && !state.ok ? (
        <p className="error">{ERRORS[state.code ?? 'OTHER'] ?? ERRORS.OTHER}</p>
      ) : null}

      <p className="key">
        Звонок и видеообзор — бесплатно и ни к чему не обязывают.
      </p>
    </form>
  );
}
