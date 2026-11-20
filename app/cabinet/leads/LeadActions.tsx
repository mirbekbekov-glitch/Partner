'use client';

import { useState } from 'react';
import { setLeadStatus, type LeadActionResult } from './actions';

const STATUSES: { status: string; label: string }[] = [
  { status: 'in_work', label: 'Взять в работу' },
  { status: 'done', label: 'Отработана' },
  { status: 'spam', label: 'Спам' },
];

/**
 * Кнопки статуса заявки.
 *
 * Каждая кнопка — отдельная форма: вложенных форм в разметке не бывает, а
 * одна форма с несколькими значениями потребовала бы formAction и читалась
 * бы хуже.
 */
export function LeadActions({ leadId, status }: { leadId: string; status: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<LeadActionResult | null>(null);

  return (
    <div className="actions">
      {STATUSES.filter((s) => s.status !== status).map((s) => (
        <form
          key={s.status}
          action={async (fd: FormData) => {
            setBusy(s.status);
            setResult(await setLeadStatus(fd));
            setBusy(null);
          }}
        >
          <input type="hidden" name="lead_id" value={leadId} />
          <input type="hidden" name="status" value={s.status} />
          <button type="submit" className="ghost" disabled={busy !== null}>
            {busy === s.status ? '…' : s.label}
          </button>
        </form>
      ))}
      {result?.error ? <span className="error inline-error">{result.error}</span> : null}
    </div>
  );
}
