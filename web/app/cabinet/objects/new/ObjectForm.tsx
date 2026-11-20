"use client";

import { useActionState, useState } from "react";
import { KIND_LABEL } from "../../../../lib/format";
import type { Result } from "../../actions";

/**
 * Форма заведения объекта.
 *
 * Поля управляемые, и это не вкусовщина. React 19 после завершения действия
 * сбрасывает неуправляемые поля формы — то есть агент заполняет двенадцать
 * полей, получает одну ошибку от базы («у объекта должен быть собственник»)
 * и теряет всё, что ввёл. Проверено браузером: после отказа в полях адреса и
 * цены оставалась пустота.
 *
 * Одно состояние на всю форму вместо двенадцати: полей много, и заводить на
 * каждое свой useState значит писать двенадцать раз одно и то же.
 */
export function ObjectForm({
  action,
  initial,
  contacts,
  candidateId,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  initial: Record<string, string>;
  contacts: { id: string; name: string; phone: string | null }[];
  candidateId?: string;
}) {
  const [state, submit, pending] = useActionState(action, null as Result | null);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [confirmed, setConfirmed] = useState(false);

  const field = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
  });

  // Собственник выбран из списка — имя и телефон не нужны, и спрашивать их
  // значит предлагать завести второго такого же человека.
  const known = (values.contact_id ?? "") !== "";

  return (
    <form action={submit} className="act">
      {candidateId && <input type="hidden" name="candidate_id" value={candidateId} />}

      <fieldset>
        <legend>Объект</legend>

        <div className="pair">
          <label>
            Вид
            <select {...field("kind")} required>
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Сделка
            <select {...field("deal_type")} required>
              <option value="sale">Продажа</option>
              <option value="rent">Аренда</option>
            </select>
          </label>
        </div>

        <label>
          Адрес
          <input {...field("address")} placeholder="Киевская 148, кв. 44" required />
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
            Район <span className="opt">— необязательно</span>
            <input {...field("zone")} placeholder="Центр" />
          </label>
          <label>
            Комнат <span className="opt">— необязательно</span>
            <input {...field("rooms")} inputMode="numeric" />
          </label>
        </div>

        <div className="pair">
          <label>
            Площадь, м² <span className="opt">— необязательно</span>
            <input {...field("area")} inputMode="decimal" />
          </label>
          <label>
            Этаж и всего этажей <span className="opt">— необязательно</span>
            <span className="row-pair">
              <input {...field("floor")} inputMode="numeric" aria-label="Этаж" />
              <input {...field("floors_total")} inputMode="numeric" aria-label="Всего этажей" />
            </span>
          </label>
        </div>

        <label>
          Описание <span className="opt">— необязательно</span>
          <textarea {...field("description")} rows={3} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Собственник</legend>

        {contacts.length > 0 && (
          <label>
            Уже известный
            <select {...field("contact_id")}>
              <option value="">— новый собственник —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {!known && (
          <>
            <div className="pair">
              <label>
                Имя
                <input {...field("owner_name")} placeholder="Орозов Азамат" />
              </label>
              <label>
                Телефон
                <input {...field("owner_phone")} type="tel" placeholder="0700 123 456" />
              </label>
            </div>
            <p className="hint">
              Телефон приводится к единому виду, и если такой номер уже есть —
              объект привяжется к тому же человеку, а не к его второй копии.
            </p>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Договор</legend>

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

        <label className="check">
          <input
            type="checkbox"
            name="contract_confirmed"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          Договор подписан
        </label>
        <p className="hint">
          Неподписанный договор не мешает завести объект и опубликовать его, но
          объект будет помечен как требующий внимания, пока подпись не
          появится.
        </p>
      </fieldset>

      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Заводим…" : "Завести объект"}
      </button>

      {state?.ok === false && <p className="act-err">{state.error}</p>}
    </form>
  );
}
