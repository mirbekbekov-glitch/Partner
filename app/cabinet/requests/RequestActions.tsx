'use client';

import { useState } from 'react';
import {
  takeRequest, releaseRequest, answerRequest, closeRequest, convertRequest,
  type RequestActionResult,
} from './actions';

const REASONS: [string, string][] = [
  ['deal', 'довели до сделки'],
  ['found_self', 'нашёл сам'],
  ['changed_mind', 'передумал'],
  ['no_answer', 'не дозвонились'],
  ['spam', 'спам'],
  ['other', 'другое'],
];

/**
 * Кнопки над заявкой.
 *
 * Набор зависит от того, чья заявка и что с ней уже сделано: показывать
 * «Вернуть в ленту» на чужой заявке — значит обещать то, чего база не
 * разрешит. Каждая кнопка — отдельная форма: вложенных форм не бывает.
 */
export function RequestActions({
  id, mine, hasContact, answered,
}: {
  id: string;
  mine: 'available' | 'mine' | 'other';
  hasContact: boolean;
  answered: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RequestActionResult | null>(null);
  const [closing, setClosing] = useState(false);

  const run = (key: string, fn: (fd: FormData) => Promise<RequestActionResult>) =>
    async (fd: FormData) => { setBusy(key); setResult(await fn(fd)); setBusy(null); };

  if (mine === 'other') {
    return <span className="key">ведёт другой агент</span>;
  }

  return (
    <div className="actions">
      {mine === 'available' ? (
        <form action={run('take', takeRequest)}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" disabled={busy !== null}>
            {busy === 'take' ? '…' : 'Взять в работу'}
          </button>
        </form>
      ) : null}

      {mine === 'mine' ? (
        <>
          {/* Отметка о разговоре закрывает счётчик первого ответа. Пустую
              база не примет: счётчик должен закрывать разговор, а не
              нажатие кнопки. */}
          {!answered ? (
            <form action={run('answer', answerRequest)} className="inline">
              <input type="hidden" name="id" value={id} />
              <input name="note" placeholder="чем закончился разговор" required
                     maxLength={500} />
              <button type="submit" disabled={busy !== null}>
                {busy === 'answer' ? '…' : 'Отметить ответ'}
              </button>
            </form>
          ) : null}

          {!hasContact ? (
            <form action={run('convert', convertRequest)}>
              <input type="hidden" name="id" value={id} />
              <button type="submit" className="ghost" disabled={busy !== null}>
                {busy === 'convert' ? '…' : 'Завести клиента'}
              </button>
            </form>
          ) : null}

          <form action={run('release', releaseRequest)}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" className="ghost" disabled={busy !== null}>
              {busy === 'release' ? '…' : 'Вернуть в ленту'}
            </button>
          </form>

          {closing ? (
            <form action={run('close', closeRequest)} className="inline">
              <input type="hidden" name="id" value={id} />
              <select name="reason" defaultValue="found_self" aria-label="Причина закрытия">
                {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="submit" disabled={busy !== null}>
                {busy === 'close' ? '…' : 'Закрыть'}
              </button>
            </form>
          ) : (
            <button type="button" className="ghost" onClick={() => setClosing(true)}>
              Закрыть заявку
            </button>
          )}
        </>
      ) : null}

      {result?.error ? <p className="error">{result.error}</p> : null}
    </div>
  );
}
