import { ActionForm } from "./ActionForm";
import type { Result } from "./actions";

/**
 * Передача клиента или объекта другому агенту.
 *
 * Под складкой, а не кнопкой на виду: это редкое действие с последствиями,
 * и место рядом с ежедневными кнопками ему ни к чему. Но и прятать его в
 * настройки незачем — в отпуск уходят не из настроек.
 */
export function Transfer({
  action,
  what,
  hidden,
  targets,
  note,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  what: "объект" | "клиента";
  hidden: Record<string, string>;
  targets: { id: string; full_name: string; role: string }[];
  note: string;
}) {
  if (targets.length === 0) {
    return (
      <p className="muted">
        Передать {what} некому: в агентстве нет других действующих агентов.
      </p>
    );
  }

  return (
    <details className="fold">
      <summary>Передать {what} другому агенту</summary>
      <div className="card">
        <ActionForm
          action={action}
          label={`Передать ${what}`}
          confirm={`Передать ${what} другому агенту? ${note}`}
        >
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label>
            Кому
            <select name="to_agent" defaultValue="" required>
              <option value="" disabled>— выберите агента —</option>
              {targets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                  {a.role === "admin" ? " (администратор)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{note}</p>
        </ActionForm>
      </div>
    </details>
  );
}
