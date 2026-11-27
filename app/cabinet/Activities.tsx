'use client';

import { useActionState, useState } from 'react';
import {
  addActivity,
  toggleActivity,
  deleteActivity,
  reassign,
  type ActivityResult,
} from './activity-actions';

export type Colleague = { id: string; full_name: string };

/* Словарь видов — из обычного модуля, не отсюда: этот файл помечен
   'use client', и серверная страница задач, читая KIND_RU прямо из него,
   получала не словарь, а ссылку на клиентский модуль. На незакрытом
   звонке KIND_RU['call'] отдавал Function.prototype.call, и страница
   падала с 500. Здесь он только переэкспортируется для своих же нужд. */
export { KIND_RU } from '@/lib/activity-kinds';
import { KIND_RU } from '@/lib/activity-kinds';

export type ActivityRow = {
  id: string;
  kind: string;
  body: string | null;
  due_at: string | null;
  done: boolean;
  done_at: string | null;
  is_shared: boolean;
  created_at: string;
  agent_name: string | null;
  mine: boolean;
  overdue: boolean;
  entity_title?: string | null;
  entity_type?: string;
  entity_id?: string;
};

import { activityWhen as when } from '@/lib/activity-format';

/**
 * Кнопки «выполнено» и «удалить».
 *
 * Отдельно от разметки строки: на карточке сущности они стоят под текстом
 * записи, а в таблице задач — в своей колонке. Логика при этом одна.
 *
 * Править и отмечать можно только своё: политика чужую строку не находит,
 * поэтому у чужой записи кнопок нет вовсе.
 */
export function ActivityActions(
  { a, colleagues = [] }: { a: ActivityRow; colleagues?: Colleague[] },
) {
  const [, toggle, toggling] = useActionState<ActivityResult, FormData>(
    async (_p, fd) => toggleActivity(fd),
    { error: null },
  );
  const [delState, del, deleting] = useActionState<ActivityResult, FormData>(
    async (_p, fd) => deleteActivity(fd),
    { error: null },
  );
  const [handState, handOver, handing] = useActionState<ActivityResult, FormData>(
    async (_p, fd) => reassign(fd),
    { error: null },
  );

  if (!a.mine) return null;

  // Передавать осмысленно только незакрытое и только когда есть кому:
  // у одинокого агента этот выпадающий список был бы пустым обещанием.
  const canHandOver = !a.done && colleagues.length > 0;

  return (
    <div className="actions">
      <form action={toggle} style={{ display: 'inline' }}>
        <input type="hidden" name="id" value={a.id} />
        <input type="hidden" name="done" value={a.done ? 'false' : 'true'} />
        <button type="submit" disabled={toggling} className="ghost">
          {a.done ? 'вернуть в работу' : 'выполнено'}
        </button>
      </form>
      <form
        action={del}
        style={{ display: 'inline' }}
        onSubmit={(e) => {
          if (!window.confirm('Удалить запись? Она исчезнет без возможности вернуть.')) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="id" value={a.id} />
        <button type="submit" disabled={deleting} className="ghost">удалить</button>
      </form>
      {canHandOver ? (
        <form action={handOver} className="hand-over">
          <input type="hidden" name="id" value={a.id} />
          {/* Передача — одно действие, а не «выбрать и подтвердить»: выбор
              без кнопки сработал бы от случайного промаха по списку. */}
          <select name="to_agent_id" required defaultValue=""
                  aria-label="Передать коллеге">
            <option value="" disabled>передать…</option>
            {colleagues.map((c) => (
              <option key={c.id} value={c.id}>{c.full_name}</option>
            ))}
          </select>
          <button type="submit" disabled={handing} className="ghost">передать</button>
        </form>
      ) : null}
      {delState.error ? <span className="error inline-error">{delState.error}</span> : null}
      {handState.error ? <span className="error inline-error">{handState.error}</span> : null}
    </div>
  );
}

/** Состояние записи одной строкой: тип, срок, общая ли, чья. */
export function ActivityMeta({ a }: { a: ActivityRow }) {
  return (
    <>
      {a.done ? <span className="key">выполнено {when(a.done_at)}</span> : null}
      {a.overdue ? <span className="warn">просрочено</span> : null}
      {a.due_at && !a.done ? <span className="key">срок {when(a.due_at)}</span> : null}
      {a.is_shared ? (
        <span className="key" title="Видна тем, кто работает по этой сущности">общая</span>
      ) : null}
    </>
  );
}

export { activityWhen } from '@/lib/activity-format';

function Row({ a, colleagues }: { a: ActivityRow; colleagues?: Colleague[] }) {
  return (
    <div className="act">
      <div className="row">
        <span className="tag">{KIND_RU[a.kind] ?? a.kind}</span>
        <ActivityMeta a={a} />
        {!a.mine ? <span className="key">{a.agent_name}</span> : null}
      </div>

      {a.body ? <p className="act-body">{a.body}</p> : null}

      <ActivityActions a={a} colleagues={colleagues} />
    </div>
  );
}

/** Блок активностей на карточке сущности. */
export function Activities({
  entityType,
  entityId,
  rows,
  colleagues = [],
}: {
  entityType: string;
  entityId: string;
  rows: ActivityRow[];
  colleagues?: Colleague[];
}) {
  const [state, formAction, pending] = useActionState<ActivityResult, FormData>(
    async (_p, fd) => addActivity(fd),
    { error: null },
  );
  const [kind, setKind] = useState('note');

  const open = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done);

  return (
    <>
      <h2>Активности ({open.length})</h2>

      <form action={formAction} className="stack card">
        <input type="hidden" name="entity_type" value={entityType} />
        <input type="hidden" name="entity_id" value={entityId} />

        <div className="inline">
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}
                  aria-label="Тип активности">
            {Object.entries(KIND_RU).map(([v, t]) => (
              <option key={v} value={v}>{t}</option>
            ))}
          </select>
          {/* Срок осмысленен для задач и назначенных показов. */}
          {kind === 'task' || kind === 'showing' ? (
            <input name="due_at" type="datetime-local" aria-label="Срок" />
          ) : null}
          {/* Поставить на коллегу можно задачу и показ. Заметку и звонок —
              нет: это запись о том, что сделал ТЫ, и приписать её другому
              значило бы сочинять за него историю. */}
          {(kind === 'task' || kind === 'showing') && colleagues.length > 0 ? (
            <select name="agent_id" defaultValue="" aria-label="На кого">
              <option value="">на себя</option>
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
          ) : null}
        </div>

        <textarea name="body" rows={2} placeholder="что произошло или что нужно сделать" />

        <label className="check">
          <input type="checkbox" name="is_shared" /> видна коллегам, работающим по этой
          записи
        </label>
        <p className="key">
          По умолчанию запись видите только вы и администратор. Если поделитесь — её
          прочтёт тот, кто отвечает за этот объект, потребность или сделку.{' '}
          <strong>Не пишите в общую запись телефон клиента или собственника:</strong> тому,
          кто отвечает за объект, телефон клиента не положен, пока нет активной сделки.
        </p>

        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Записываем…' : 'Записать'}
          </button>
        </div>
        {state.error ? <p className="error">{state.error}</p> : null}
      </form>

      {open.length === 0 && done.length === 0 ? (
        <p className="empty">Записей пока нет.</p>
      ) : null}

      {open.map((a) => <Row key={a.id} a={a} colleagues={colleagues} />)}

      {done.length > 0 ? (
        <>
          <h2>Выполнено ({done.length})</h2>
          {done.map((a) => <Row key={a.id} a={a} />)}
        </>
      ) : null}
    </>
  );
}

export { Row as ActivityRowView };
