'use client';

import { useActionState } from 'react';
import { createMatch } from './actions';

type Option = { id: string; label: string };
type State = { error: string | null };

async function action(_prev: State, formData: FormData): Promise<State> {
  return createMatch(formData);
}

/**
 * Кнопка «создать подбор».
 *
 * Одна сторона пары зафиксирована (та карточка, на которой мы стоим),
 * вторая выбирается из списка. Ошибку пишет база — см. actions.ts.
 */
export function CreateMatchForm({
  fixed,
  fixedValue,
  options,
  back,
  emptyHint,
}: {
  fixed: 'object' | 'requirement';
  fixedValue: string;
  options: Option[];
  back: string;
  emptyHint: string;
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, { error: null });

  if (options.length === 0) {
    return <p className="sub">{emptyHint}</p>;
  }

  const selectName = fixed === 'object' ? 'requirement_id' : 'object_id';
  const fixedName = fixed === 'object' ? 'object_id' : 'requirement_id';

  return (
    <>
      <form className="inline" action={formAction}>
        <input type="hidden" name={fixedName} value={fixedValue} />
        <input type="hidden" name="back" value={back} />
        <label className="key" htmlFor="match-target">
          {fixed === 'object' ? 'Потребность' : 'Объект'}
        </label>
        <select id="match-target" name={selectName} required defaultValue="">
          <option value="" disabled>
            — выберите —
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending}>
          {pending ? 'Создаём…' : 'Создать подбор'}
        </button>
      </form>
      {state.error ? <p className="error">{state.error}</p> : null}
    </>
  );
}
