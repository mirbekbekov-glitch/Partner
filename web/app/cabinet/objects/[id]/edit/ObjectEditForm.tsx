"use client";

import { useActionState, useState } from "react";
import { KIND_LABEL } from "../../../../../lib/format";
import type { Result } from "../../../actions";

/**
 * Правка объекта, договора, собственника и ставки — четыре отдельные формы на
 * одной странице.
 *
 * Отдельные, потому что это четыре разных разговора: цену меняют с
 * собственником, срок договора — в договоре, имя — когда записали со слуха
 * неправильно, ставку — с коллегой. Одна общая кнопка «Сохранить» означала бы,
 * что правка имени требует подтверждения цены.
 *
 * Поля управляемые — React 19 сбрасывает неуправляемые после действия, и один
 * отказ стирал бы введённое.
 */
export function ObjectEditForm({
  updateObject,
  updateMandate,
  updateClosingShare,
  updateContact,
  object,
  mandate,
  owner,
}: {
  updateObject: (prev: unknown, form: FormData) => Promise<Result>;
  updateMandate: (prev: unknown, form: FormData) => Promise<Result>;
  updateClosingShare: (prev: unknown, form: FormData) => Promise<Result>;
  updateContact: (prev: unknown, form: FormData) => Promise<Result>;
  object: Record<string, string> & { id: string };
  mandate: { id: string; kind: string; valid_to: string; contract_confirmed: boolean;
             closing_percent: string } | null;
  owner: { id: string; name: string; phone: string } | null;
}) {
  return (
    <>
      <Section title="Объект" action={updateObject} label="Сохранить объект"
               initial={object} hidden={{ object_id: object.id }}>
        {(field) => (
          <>
            <label>
              Адрес
              <input {...field("address")} required />
            </label>
            <div className="pair">
              <label>
                Цена
                <input {...field("price")} inputMode="decimal" required />
              </label>
              <label>
                Валюта
                <select {...field("currency")}>
                  <option value="USD">USD</option>
                  <option value="KGS">сом</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
            </div>
            <div className="pair">
              <label>
                Район
                <input {...field("zone")} />
              </label>
              <label>
                Комнат
                <input {...field("rooms")} inputMode="numeric" />
              </label>
            </div>
            <div className="pair">
              <label>
                Площадь, м²
                <input {...field("area")} inputMode="decimal" />
              </label>
              <label>
                Этаж и всего этажей
                <span className="row-pair">
                  <input {...field("floor")} inputMode="numeric" aria-label="Этаж" />
                  <input {...field("floors_total")} inputMode="numeric" aria-label="Всего этажей" />
                </span>
              </label>
            </div>
            <label>
              Описание
              <textarea {...field("description")} rows={3} />
            </label>
            <p className="hint">
              Правка цены или описания поднимает дату подтверждения
              актуальности: покупатель видит, что объявление свежее, и это
              должно быть правдой. Вид объекта ({KIND_LABEL[object.kind as keyof typeof KIND_LABEL] ?? object.kind})
              и тип сделки здесь не меняются — это другой объект, а не правка
              этого.
            </p>
          </>
        )}
      </Section>

      {mandate && (
        <>
          <Section title="Договор" action={updateMandate} label="Сохранить договор"
                   initial={{ mandate_kind: mandate.kind, valid_to: mandate.valid_to }}
                   hidden={{ object_id: object.id, mandate_id: mandate.id }}
                   checkbox={{ name: "contract_confirmed", label: "Договор подписан",
                               checked: mandate.contract_confirmed }}>
            {(field) => (
              <>
                <div className="pair">
                  <label>
                    Вид
                    <select {...field("mandate_kind")}>
                      <option value="non_exclusive">Неэксклюзивный</option>
                      <option value="exclusive">Эксклюзивный</option>
                    </select>
                  </label>
                  <label>
                    Действует до <span className="opt">— пусто значит бессрочно</span>
                    <input {...field("valid_to")} type="date" />
                  </label>
                </div>
              </>
            )}
          </Section>

          <Section title="Ставка агента покупателя" action={updateClosingShare}
                   label="Сохранить ставку"
                   initial={{ percent: mandate.closing_percent }}
                   hidden={{ object_id: object.id, mandate_id: mandate.id }}>
            {(field) => (
              <>
                <label>
                  Доля агента покупателя, %
                  <input {...field("percent")} inputMode="decimal" />
                </label>
                <p className="hint">
                  Назначает владелец договора — то есть вы. По умолчанию
                  50/50. После закрытия сделки ставка на неё уже не влияет:
                  суммы зафиксированы.
                </p>
              </>
            )}
          </Section>
        </>
      )}

      {owner && (
        <Section title="Собственник" action={updateContact} label="Сохранить собственника"
                 initial={{ name: owner.name, phone: owner.phone }}
                 hidden={{ contact_id: owner.id, back: `/cabinet/objects/${object.id}` }}>
          {(field) => (
            <>
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
              <p className="hint">
                Телефон заменяет основной, а не добавляет второй, и
                приводится к единому виду.
              </p>
            </>
          )}
        </Section>
      )}
    </>
  );
}

/** Одна форма-раздел со своим состоянием и своим ответом базы. */
function Section({
  title,
  action,
  label,
  initial,
  hidden,
  checkbox,
  children,
}: {
  title: string;
  action: (prev: unknown, form: FormData) => Promise<Result>;
  label: string;
  initial: Record<string, string>;
  hidden: Record<string, string>;
  checkbox?: { name: string; label: string; checked: boolean };
  children: (
    field: (name: string) => {
      name: string;
      value: string;
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
    },
  ) => React.ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, null as Result | null);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [checked, setChecked] = useState(checkbox?.checked ?? false);

  const field = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
  });

  return (
    <form action={submit} className="act card">
      <h2>{title}</h2>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children(field)}
      {checkbox && (
        <label className="check">
          <input
            type="checkbox"
            name={checkbox.name}
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />{" "}
          {checkbox.label}
        </label>
      )}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Сохраняем…" : label}
      </button>
      {state?.ok === false && <p className="act-err">{state.error}</p>}
    </form>
  );
}
