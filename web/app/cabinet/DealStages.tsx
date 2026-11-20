import { formatDate } from "../../lib/format";
import { ActionForm } from "./ActionForm";
import type { Result } from "./actions";

/**
 * Этапы сделки.
 *
 * Показаны все четыре сразу, а не выпадающим списком: агент должен видеть,
 * где сделка стоит и что будет дальше, не раскрывая ничего. Пройденные
 * отмечены, текущий выделен, у текущего написано, сколько он уже длится.
 *
 * Назад двигаться можно, и кнопки назад тоже есть: на подписании выясняется,
 * что нужен ещё документ. Запрет на возврат заставил бы агента врать системе
 * о том, где он стоит, а неправдивый этап хуже отсутствующего.
 */

export const STAGES = [
  { key: "deposit", label: "Задаток", what: "внесён задаток, стороны договорились" },
  { key: "documents", label: "Документы", what: "собираются справки и правоустанавливающие" },
  { key: "signing", label: "Подписание", what: "договор у нотариуса" },
  { key: "settlement", label: "Расчёт", what: "передача денег и регистрация" },
] as const;

export function DealStages({
  action,
  dealId,
  current,
  stageSince,
  daysInStage,
  budgetDays,
  canMove,
}: {
  action: (prev: unknown, form: FormData) => Promise<Result>;
  dealId: string;
  current: string;
  stageSince: Date | string;
  daysInStage: number;
  budgetDays: number | null;
  canMove: boolean;
}) {
  const index = STAGES.findIndex((s) => s.key === current);
  const stuck = budgetDays !== null && daysInStage > budgetDays;

  return (
    <section className="card">
      <h2>Этап</h2>

      <ol className="stages">
        {STAGES.map((s, i) => {
          const state = i < index ? "done" : i === index ? "now" : "next";
          return (
            <li key={s.key} className={`stage ${state}`}>
              <strong>{s.label}</strong>
              <span>{s.what}</span>
              {state === "now" && (
                <em className={stuck ? "stuck" : undefined}>
                  здесь {daysInStage} {dayWord(daysInStage)}
                  {budgetDays !== null ? ` из ${budgetDays}` : ""}
                  {stuck ? " — пора звонить" : ""}
                </em>
              )}
            </li>
          );
        })}
      </ol>

      <p className="muted">
        На этапе с {formatDate(stageSince)}.
      </p>

      {canMove && (
        <div className="acts-bar">
          {STAGES.filter((s) => s.key !== current).map((s) => (
            <ActionForm key={s.key} action={action} label={`→ ${s.label}`}>
              <input type="hidden" name="deal_id" value={dealId} />
              <input type="hidden" name="stage" value={s.key} />
            </ActionForm>
          ))}
        </div>
      )}
    </section>
  );
}

function dayWord(n: number): string {
  const last = n % 10;
  const two = n % 100;
  if (two >= 11 && two <= 14) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}
