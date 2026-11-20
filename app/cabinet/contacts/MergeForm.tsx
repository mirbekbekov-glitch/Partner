'use client';

import { useActionState } from 'react';
import { mergeContacts, type MergeResult } from './actions';

export type DuplicateCandidate = {
  other_id: string;
  other_name: string;
  other_phones: number;
  other_requirements: number;
};

/**
 * Объединение дубликата.
 *
 * Действие необратимое: присоединяемая запись удаляется. Поэтому
 * подтверждение называет, что именно переедет, а кандидаты предлагаются
 * только из тех пар, где обе записи видны агенту.
 */
export function MergeForm({
  keepId,
  keepName,
  candidates,
}: {
  keepId: string;
  keepName: string;
  candidates: DuplicateCandidate[];
}) {
  const [state, formAction, pending] = useActionState<MergeResult, FormData>(
    async (_p, fd) => mergeContacts(fd),
    { error: null, done: null },
  );

  if (state.done) return <p className="key">{state.done}</p>;

  if (candidates.length === 0) {
    return (
      <p className="key">
        Записей с таким же именем не найдено. Новые дубликаты по телефону схема
        больше не пускает.
      </p>
    );
  }

  return (
    <>
      <p className="key">
        Найдены записи с таким же именем. Присоединяемая запись будет{' '}
        <strong>удалена</strong>, а её телефоны, объекты, потребности и заметки
        перейдут к «{keepName}». Роли сложатся вместе.
      </p>

      {candidates.map((c) => (
        <form
          key={c.other_id}
          action={formAction}
          className="inline"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            if (
              !window.confirm(
                `Присоединить «${c.other_name}» к «${keepName}»? ` +
                  `Запись «${c.other_name}» будет удалена. Отменить это будет нельзя.`,
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="keep_id" value={keepId} />
          <input type="hidden" name="merge_id" value={c.other_id} />
          <span>
            <strong>{c.other_name}</strong>{' '}
            <span className="key">
              телефонов {c.other_phones}, потребностей {c.other_requirements}
            </span>
          </span>
          <button type="submit" disabled={pending} className="ghost">
            {pending ? '…' : 'присоединить к этой записи'}
          </button>
        </form>
      ))}

      {state.error ? <p className="error">{state.error}</p> : null}
    </>
  );
}
