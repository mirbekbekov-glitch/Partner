'use client';

import { useActionState } from 'react';
import { objectAction, type FormResult } from './form-actions';

type Props = {
  objectId: string;
  publicationState: string;
  activeMandateId: string | null;
  canEdit: boolean;
};

function Act({
  objectId,
  what,
  label,
  extra,
  confirmText,
}: {
  objectId: string;
  what: string;
  label: string;
  extra?: Record<string, string>;
  confirmText?: string;
}) {
  const [state, formAction, pending] = useActionState<FormResult, FormData>(
    async (_prev, fd) => objectAction(fd),
    { error: null },
  );

  return (
    <>
      <form
        action={formAction}
        style={{ display: 'inline' }}
        onSubmit={(e) => {
          if (confirmText && !window.confirm(confirmText)) e.preventDefault();
        }}
      >
        <input type="hidden" name="id" value={objectId} />
        <input type="hidden" name="what" value={what} />
        {Object.entries(extra ?? {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <button type="submit" disabled={pending} className="ghost">
          {pending ? '…' : label}
        </button>
      </form>
      {state.error ? <span className="error inline-error">{state.error}</span> : null}
    </>
  );
}

export function ObjectActions({ objectId, publicationState, activeMandateId, canEdit }: Props) {
  if (!canEdit) {
    return (
      <p className="key">
        Правка доступна тому, кто завёл объект, listing-агенту активного мандата и
        администратору.
      </p>
    );
  }

  return (
    <div className="actions">
      {/* Без активного мандата публиковать нечего — кнопку не показываем,
          иначе она только собирала бы отказы (инвариант 1). */}
      {activeMandateId && publicationState !== 'published' ? (
        <Act objectId={objectId} what="publish" label="Опубликовать" />
      ) : null}

      {publicationState === 'published' ? (
        <Act
          objectId={objectId}
          what="withdraw"
          label="Снять с публикации"
          confirmText="Снять объект с публикации? Он исчезнет из каталога и из каналов."
        />
      ) : null}

      <Act objectId={objectId} what="confirm_actual" label="Подтвердить актуальность" />

      {activeMandateId ? (
        <Act
          objectId={objectId}
          what="terminate_mandate"
          label="Расторгнуть мандат"
          extra={{ mandate_id: activeMandateId }}
          confirmText="Расторгнуть договор? Объект будет снят с публикации и со всех каналов, потому что без активного мандата он в каталоге быть не может."
        />
      ) : (
        <>
          <Act
            objectId={objectId}
            what="create_mandate"
            label="Заключить неэксклюзив"
            extra={{ mandate_kind: 'non_exclusive' }}
          />
          <Act
            objectId={objectId}
            what="create_mandate"
            label="Заключить эксклюзив"
            extra={{ mandate_kind: 'exclusive' }}
          />
        </>
      )}
    </div>
  );
}
