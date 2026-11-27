'use client';

import { useActionState, useState } from 'react';
import { inviteAgentLink, type InviteState } from './actions';

/**
 * Выдача ссылки-приглашения.
 *
 * Почему это вообще нужно: вход устроен письмом, а на бесплатном плане
 * Workers письмо уходит только на заранее подтверждённый адрес. Адрес
 * нового агента никто не подтверждал, поэтому ссылку передаёт админ —
 * тем же путём, которым агентство и так заводит людей.
 *
 * Ссылка показывается ОДИН раз. В базе лежит только её хэш, достать её
 * оттуда нельзя, и перезагрузка страницы её теряет. Поэтому сказано прямо
 * под полем, а не мелким шрифтом: иначе человек закроет страницу и придёт
 * с вопросом, где посмотреть выданную ссылку.
 */
export function InviteForm() {
  const [state, formAction, pending] = useActionState<InviteState | null, FormData>(
    inviteAgentLink, null,
  );
  const [copied, setCopied] = useState(false);

  return (
    <div className="card">
      <strong>Завести агента</strong>
      <p className="key">
        Впишите почту — получите ссылку и передайте её сами: в WhatsApp, в
        Telegram, голосом. Письмо агентству не отправляется, потому что на
        текущем плане оно дойдёт только на заранее подтверждённый адрес.
      </p>

      <form action={formAction} className="stack" style={{ marginTop: 10 }}>
        <div className="field">
          <label className="key" htmlFor="invite_name">Имя и фамилия</label>
          <input
            id="invite_name"
            name="full_name"
            type="text"
            placeholder="Нурлан Орозов"
            autoComplete="off"
          />
          {/* Не обязательно, но лучше вписать: без имени в списке агентов
              будет стоять почта, и опознать заявку труднее. */}
          <p className="key">Не обязательно. Без него в списке будет стоять почта.</p>
        </div>

        <div className="field">
          <label className="key" htmlFor="invite_email">Почта</label>
          <input
            id="invite_email"
            name="email"
            type="email"
            required
            placeholder="agent@example.kg"
            autoComplete="off"
          />
          <p className="key">
            Она станет ключом к учётной записи: дальше агент входит по ней сам.
          </p>
        </div>

        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Готовим ссылку…' : 'Выдать ссылку'}
          </button>
        </div>
      </form>

      {state?.error ? <p className="error">{state.error}</p> : null}

      {state?.link ? (
        <div className="invite-out">
          <p>
            <b>{state.full_name}</b> <span className="key">{state.email}</span>
            {state.existed ? (
              <span className="tag">уже был в списке — выдана новая ссылка</span>
            ) : null}
          </p>

          {/* readOnly, а не disabled: отключённое поле нельзя выделить, а
              ссылку надо скопировать даже там, где кнопка копирования не
              сработает (старый браузер, доступ к буферу закрыт). */}
          <input
            className="mono"
            readOnly
            value={state.link}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Ссылка для входа"
          />

          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.link ?? '');
                  setCopied(true);
                } catch {
                  // Буфер закрыт настройками браузера. Поле выше остаётся
                  // рабочим, поэтому молча ничего не обещаем.
                  setCopied(false);
                }
              }}
            >
              Скопировать
            </button>
            {copied ? <span className="key">Скопировано</span> : null}
          </div>

          <p className="warn">
            Ссылку видно только сейчас — в базе от неё лежит лишь отпечаток.
            Она действует сутки и срабатывает один раз. Кто по ней пройдёт,
            тот и войдёт как {state.full_name}: передавайте её лично, а не в
            общий чат.
          </p>
          <p className="key">
            Агент заведён и ждёт одобрения — найдите его в списке ниже.
          </p>
        </div>
      ) : null}
    </div>
  );
}
