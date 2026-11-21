"use client";

import { useActionState } from "react";
import { pause, type PauseResult } from "./actions";

/**
 * Кнопка собственника: приостановить или возобновить показы.
 *
 * Единственный клиентский компонент кабинета собственника, и он здесь по той
 * же причине, что ActionForm в кабинете агента: ответ базы надо показать
 * рядом с кнопкой, которую нажали. «Это не ваш объект» в шапке страницы
 * ничего не объясняет.
 */
export function PauseForm({
  token,
  objectId,
  paused,
}: {
  token: string;
  objectId: string;
  paused: boolean;
}) {
  const [state, submit, pending] = useActionState(pause, null as PauseResult | null);

  const form = (
    <form action={submit} className="owner-act">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="object_id" value={objectId} />
      <input type="hidden" name="paused" value={paused ? "0" : "1"} />

      {!paused && (
        <label>
          Почему приостанавливаем
          <input
            name="reason"
            placeholder="Уезжаю до декабря"
            required
            maxLength={200}
          />
          <span className="hint">
            Агенту надо знать, что отвечать тем, кто уже хотел посмотреть.
          </span>
        </label>
      )}

      <button type="submit" disabled={pending} className={paused ? "btn" : "btn danger"}>
        {pending ? "…" : paused ? "Возобновить показы" : "Приостановить показы"}
      </button>
    </form>
  );

  // Ответ стоит ВНЕ складки, и это не оформление. Пока он лежал внутри формы,
  // «Показы возобновлены» появлялось в складке, которая от снятия паузы как
  // раз и закрывалась: собственник нажимал кнопку и не видел ничего. Ответ
  // живёт там, где он виден в обоих состояниях.
  const answer =
    state?.ok === false ? (
      <p className="act-err">{state.error}</p>
    ) : state?.ok === true ? (
      <p className="act-ok">{state.message}</p>
    ) : null;

  // Возобновление — один щелчок, и прятать его незачем: собственник,
  // закрывший дверь, ищет именно эту кнопку. А приостановка просит причину,
  // и раскрытая форма у каждого объекта превращает страницу в простыню.
  return (
    <>
      {paused ? (
        form
      ) : (
        <details className="fold">
          <summary>Приостановить показы</summary>
          {form}
        </details>
      )}
      {answer}
    </>
  );
}
