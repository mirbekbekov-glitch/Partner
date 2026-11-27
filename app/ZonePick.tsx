'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { zoneMatch } from '@/lib/geo';

/**
 * Выбор района.
 *
 * Нативный список не подошёл по одной причине: районов города два
 * десятка, и в нативном списке их можно только пролистать глазами.
 * Человек знает, что ищет «Асанбай», и хочет набрать «ас», а не искать
 * строку среди двадцати. Поэтому свой список с полем поиска сверху —
 * ровно так это сделано на площадках, откуда люди к нам приходят.
 *
 * Своё — значит отвечать за всё, что нативный список делает сам:
 * с клавиатуры (стрелки, Enter, Escape), закрытие по щелчку мимо,
 * возврат фокуса на кнопку после выбора и роли для чтения с экрана.
 * Ничего из этого не украшение: списком, который не слушает клавиатуру,
 * нельзя пользоваться вообще.
 *
 * Без JavaScript остаётся нативный список в <noscript>: имя поля тогда
 * у него, а у скрытого поля имени нет, и форма отправляет одно значение,
 * а не два.
 */

export type ZoneOption = { zone: string; n: number };

export function ZonePick({
  label, value, options, onPick, anyLabel, searchHint, emptyHint,
}: {
  label: string;
  value: string;
  options: ZoneOption[];
  /** Выбор уходит наверх: район зависит от города, и хранить его
      отдельно от города значило бы развести их при смене города. */
  onPick: (zone: string) => void;
  anyLabel: string;
  searchHint: string;
  emptyHint: string;
}) {
  const id = useId();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setReady(true), []);

  // Сравнение живёт в словаре географии: там же сказано, почему «6 мкр»,
  // «6 м-н» и «6 микрорайон» — одно и то же место.
  const found = options.filter((o) => zoneMatch(o.zone, query));
  const rows: Array<ZoneOption | null> = [null, ...found];

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Подсветка не должна уезжать за край: список прокручивается, а
  // стрелка на клавиатуре об этом не знает.
  useEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector<HTMLElement>('[data-at="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor, query]);

  const picked = value;

  const choose = (zone: string) => {
    onPick(zone);
    setOpen(false);
    setQuery('');
    btn.current?.focus();
    // Счётчик на кнопке «Найти» слушает форму, а скрытое поле само
    // события не шлёт: без этого число на кнопке осталось бы прежним.
    btn.current?.form?.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      choose(row ? row.zone : '');
    }
  };

  return (
    <div className="cell pick" ref={box}>
      <span className="pick-label" id={`${id}-l`}>{label}</span>

      <input type="hidden" name={ready ? 'zone' : undefined} value={picked} />

      <button
        type="button"
        ref={btn}
        className="pick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-l ${id}-b`}
        id={`${id}-b`}
        onClick={() => { setOpen((v) => !v); setCursor(0); }}
      >
        <span className={picked ? '' : 'pick-any'}>{picked || anyLabel}</span>
      </button>

      {open ? (
        <div className="pick-pop" onKeyDown={onKey}>
          <input
            ref={field}
            type="text"
            className="pick-find"
            placeholder={searchHint}
            value={query}
            autoComplete="off"
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          />
          <div className="pick-list" role="listbox" aria-labelledby={`${id}-l`} ref={list}>
            {rows.map((row, i) => {
              const zone = row ? row.zone : '';
              const on = picked === zone;
              return (
                <button
                  key={zone || '*'}
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-at={i === cursor ? 'true' : undefined}
                  className="pick-row"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(zone)}
                >
                  <span>{row ? row.zone : anyLabel}</span>
                  {/* Число — не украшение: оно говорит, стоит ли нажимать.
                      У района без объектов числа нет, и это тоже ответ. */}
                  {row && row.n > 0 ? <small className="num">{row.n}</small> : null}
                </button>
              );
            })}
            {found.length === 0 ? <p className="pick-none">{emptyHint}</p> : null}
          </div>
        </div>
      ) : null}

      <noscript>
        <select name="zone" defaultValue={value} className="pick-plain">
          <option value="">{anyLabel}</option>
          {options.map((o) => <option key={o.zone} value={o.zone}>{o.zone}</option>)}
        </select>
      </noscript>
    </div>
  );
}
