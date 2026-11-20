"use client";

import { useActionState, useState } from "react";
import type { Result } from "../../../actions";

/**
 * Правка условий клиента и его имени — две формы, два разных разговора.
 * Поля управляемые: React 19 сбрасывает неуправляемые после действия.
 */
export function RequirementEditForm({
  updateRequirement,
  updateContact,
  requirement,
  client,
}: {
  updateRequirement: (prev: unknown, form: FormData) => Promise<Result>;
  updateContact: (prev: unknown, form: FormData) => Promise<Result>;
  requirement: Record<string, string> & { id: string };
  client: { id: string; name: string; phone: string } | null;
}) {
  return (
    <>
      <Form action={updateRequirement} title="Что ищет" label="Сохранить условия"
            initial={requirement} hidden={{ requirement_id: requirement.id }}>
        {(field) => (
          <>
            <div className="pair">
              <label>
                Бюджет от
                <input {...field("budget_min")} inputMode="decimal" />
              </label>
              <label>
                Бюджет до
                <input {...field("budget_max")} inputMode="decimal" />
              </label>
            </div>
            <div className="pair">
              <label>
                Районы <span className="opt">— через запятую, пусто значит любой</span>
                <input {...field("zones")} />
              </label>
              <label>
                Комнат <span className="opt">— через запятую, пусто значит любое</span>
                <input {...field("rooms")} />
              </label>
            </div>
            <label>
              Срок
              <input {...field("deadline")} type="date" />
            </label>
            <label>
              Пожелания
              <textarea {...field("requirements_text")} rows={3} />
            </label>
            <p className="hint">
              Подбор на странице клиента пересчитается сразу: он считается от
              этих условий, а не хранится отдельно.
            </p>
          </>
        )}
      </Form>

      {client && (
        <Form action={updateContact} title="Клиент" label="Сохранить клиента"
              initial={{ name: client.name, phone: client.phone }}
              hidden={{ contact_id: client.id, back: `/cabinet/requirements/${requirement.id}` }}>
          {(field) => (
            <div className="pair">
              <label>
                Имя
                <input {...field("name")} required />
              </label>
              <label>
                Телефон
                <input {...field("phone")} type="tel" />
              </label>
            </div>
          )}
        </Form>
      )}
    </>
  );
}

function Form({
  action,
  title,
  label,
  initial,
  hidden,
  children,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  title: string;
  label: string;
  initial: Record<string, string>;
  hidden: Record<string, string>;
  children: (
    field: (name: string) => {
      name: string;
      value: string;
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    },
  ) => React.ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, null as Result | null);
  const [values, setValues] = useState<Record<string, string>>(initial);

  const field = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
  });

  return (
    <form action={submit} className="act card">
      <h2>{title}</h2>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children(field)}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Сохраняем…" : label}
      </button>
      {state?.ok === false && <p className="act-err">{state.error}</p>}
    </form>
  );
}
