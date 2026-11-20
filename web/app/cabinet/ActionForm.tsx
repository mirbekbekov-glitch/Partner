"use client";

import { useActionState } from "react";
import type { Result } from "./actions";

/**
 * Форма одного действия.
 *
 * Единственный клиентский компонент кабинета, и он здесь не ради красоты:
 * ответ базы надо показать рядом с кнопкой, которую нажали. Остальные
 * страницы — серверные, без клиентского кода вовсе.
 */
export function ActionForm({
  action,
  children,
  label,
  confirm,
  className,
  danger,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  children?: React.ReactNode;
  label: string;
  confirm?: string;
  className?: string;
  danger?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, null as Result | null);

  return (
    <form action={submit} className={className ?? "act"}>
      {children}
      <button
        type="submit"
        disabled={pending}
        className={danger ? "btn danger" : "btn"}
        // Подтверждение только там, где действие трудно отменить.
        onClick={(event) => {
          if (confirm && !window.confirm(confirm)) event.preventDefault();
        }}
      >
        {pending ? "…" : label}
      </button>
      {state?.ok === false && <p className="act-err">{state.error}</p>}
      {state?.ok === true && state.message && <p className="act-ok">{state.message}</p>}
    </form>
  );
}
