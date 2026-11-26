'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { advanceDeal } from './actions';
import type { DealListItem } from '@/lib/db/cabinet';
import { money } from '@/lib/list-params';

/**
 * Доска сделок по этапам.
 *
 * Этапы те же четыре, что принимает слой доступа: закрытие и срыв сюда не
 * попадают намеренно. Закрытие требует финальной цены и фиксирует
 * комиссию, срыв — причины; перетаскиванием такое не делается, для них
 * есть карточка сделки.
 *
 * Перетаскивание — удобство, а не единственный путь: у каждой карточки
 * есть кнопки перехода. Мышь есть не у всех, и клавиатура с пальцем
 * должны уметь то же самое.
 */
const STAGES: { key: Stage; title: string }[] = [
  { key: 'deposit', title: 'Аванс' },
  { key: 'documents', title: 'Документы' },
  { key: 'signing', title: 'Подписание' },
  { key: 'settlement', title: 'Расчёт' },
];

type Stage = 'deposit' | 'documents' | 'signing' | 'settlement';

export function Board({ rows }: { rows: DealListItem[] }) {
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = (id: string, status: Stage) => {
    setError(null);
    setMoving(id);
    const fd = new FormData();
    fd.set('id', id);
    fd.set('status', status);
    startTransition(async () => {
      const result = await advanceDeal(fd);
      setMoving(null);
      if (result.error) setError(result.error);
    });
  };

  return (
    <>
      {error ? <p className="error">{error}</p> : null}

      <div className="board">
        {STAGES.map((stage) => {
          const cards = rows.filter((d) => d.status === stage.key);

          return (
            <section
              key={stage.key}
              className="board-col"
              data-over={over === stage.key ? 'true' : undefined}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(stage.key);
              }}
              onDragLeave={() => setOver((v) => (v === stage.key ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/plain') || dragging;
                setDragging(null);
                if (id && rows.find((d) => d.id === id)?.status !== stage.key) {
                  move(id, stage.key);
                }
              }}
            >
              <h3 className="board-head">
                {stage.title} <span className="key">{cards.length}</span>
              </h3>

              {cards.length === 0 ? (
                <p className="board-empty">пусто</p>
              ) : (
                cards.map((d) => (
                  <article
                    key={d.id}
                    className="board-card"
                    draggable={d.can_act && !pending}
                    data-busy={moving === d.id ? 'true' : undefined}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', d.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(d.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                  >
                    <Link className="board-title" href={`/cabinet/deals/${d.id}`}>
                      {d.address}
                    </Link>

                    <p className="board-line">
                      {d.client_name ?? <span className="hidden-contact">клиент скрыт</span>}
                    </p>

                    <p className="board-money">
                      {money(d.commission_total, d.currency)}
                      {d.is_indicative ? <span className="key"> индикативно</span> : null}
                    </p>

                    <p className="key board-line">
                      {d.deal_type === 'sale' ? 'продажа' : 'аренда'}
                      {' · '}
                      {money(d.final_price ?? d.object_price, d.currency)}
                    </p>

                    {/* Переставить сделку может только её участник: слой
                        доступа всё равно откажет, но кнопка, которая
                        заведомо не сработает, — обман. */}
                    {d.can_act ? (
                      <div className="board-move">
                        {STAGES.filter((s) => s.key !== d.status).map((s) => (
                          <button
                            key={s.key}
                            type="button"
                            className="ghost"
                            disabled={pending}
                            onClick={() => move(d.id, s.key)}
                            title={`Перенести в «${s.title}»`}
                          >
                            {s.title}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="key board-line">вы не участник</p>
                    )}
                  </article>
                ))
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
