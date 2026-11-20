"use client";

import { useActionState, useState } from "react";
import type { Result } from "../../actions";

/**
 * Форма потребности.
 *
 * Поля управляемые по той же причине, что и в форме объекта: React 19 после
 * завершения действия сбрасывает неуправляемые поля, и один отказ от базы
 * стирал бы всё введённое.
 */
export function RequirementForm({
  action,
  contacts,
  inquiry,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  contacts: { id: string; name: string; phone: string | null }[];
  inquiry?: { id: string; name: string | null; phone: string | null; body: string | null };
}) {
  const [state, submit, pending] = useActionState(action, null as Result | null);
  const [values, setValues] = useState<Record<string, string>>({
    deal_type: "sale",
    client_name: inquiry?.name ?? "",
    client_phone: inquiry?.phone ?? "",
    contact_id: "",
    budget_min: "",
    budget_max: "",
    zones: "",
    rooms: "",
    deadline: "",
    requirements_text: inquiry?.body ?? "",
  });

  const field = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
  });

  const known = (values.contact_id ?? "") !== "";

  return (
    <form action={submit} className="act">
      {inquiry && <input type="hidden" name="inquiry_id" value={inquiry.id} />}

      <fieldset>
        <legend>Клиент</legend>

        {contacts.length > 0 && (
          <label>
            Уже известный
            <select {...field("contact_id")}>
              <option value="">— новый клиент —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {!known && (
          <div className="pair">
            <label>
              Имя
              <input {...field("client_name")} placeholder="Нургуль Сапарова" required />
            </label>
            <label>
              Телефон
              <input {...field("client_phone")} type="tel" placeholder="0700 123 456" required />
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Что ищет</legend>

        <label>
          Сделка
          <select {...field("deal_type")} required>
            <option value="sale">Покупка</option>
            <option value="rent">Аренда</option>
          </select>
        </label>

        <div className="pair">
          <label>
            Бюджет от <span className="opt">— необязательно</span>
            <input {...field("budget_min")} inputMode="decimal" />
          </label>
          <label>
            Бюджет до <span className="opt">— необязательно</span>
            <input {...field("budget_max")} inputMode="decimal" />
          </label>
        </div>

        <div className="pair">
          <label>
            Районы <span className="opt">— через запятую, пусто значит любой</span>
            <input {...field("zones")} placeholder="Центр, Юг" />
          </label>
          <label>
            Комнат <span className="opt">— через запятую, пусто значит любое</span>
            <input {...field("rooms")} placeholder="2, 3" />
          </label>
        </div>

        <label>
          Срок <span className="opt">— к какому числу надо решить</span>
          <input {...field("deadline")} type="date" />
        </label>

        <label>
          Пожелания <span className="opt">— то, чего нет в полях</span>
          <textarea {...field("requirements_text")} rows={3}
                    placeholder="Не первый и не последний этаж, рядом школа" />
        </label>

        <p className="hint">
          Незаполненное ограничением не считается: пустые районы означают
          «любой», а не «никакой». Подбор покажет и то, что выше потолка
          бюджета на десятую часть, — с пометкой.
        </p>
      </fieldset>

      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Заводим…" : "Завести клиента"}
      </button>

      {state?.ok === false && <p className="act-err">{state.error}</p>}
    </form>
  );
}
