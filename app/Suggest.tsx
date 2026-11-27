'use client';

import { useEffect, useRef, useState } from 'react';
import { zoneMatch } from '@/lib/geo';

/**
 * Поле ввода с подсказкой из словаря.
 *
 * Жёсткий список здесь не годится: словарь неизбежно отстаёт от жизни —
 * появится новый жилмассив, и агент не сможет завести объект, пока
 * кто-то не допишет файл. Свободная строка тоже не годится: «джал»,
 * «Джал-23» и «Jal» расходятся, и объект выпадает из поиска по району.
 *
 * Поэтому — строка с подсказкой: агент печатает, платформа предлагает
 * то, что уже знает, и одно нажатие приводит написание к общему. Своё
 * вписать по-прежнему можно, и ничего не блокируется.
 *
 * Подсказка — не проверка: красным ничего не подчёркивается, ошибкой
 * не считается. Это помощь, а не экзамен.
 */

export function Suggest({
  id, name, value, onChange, options, placeholder, hint,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  /** Подпись под полем, когда набранного нет в словаре. */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const found = options.filter((o) => zoneMatch(o, value)).slice(0, 40);
  const exact = options.some((o) => o.toLowerCase() === value.trim().toLowerCase());

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-at="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  const pick = (v: string) => { onChange(v); setOpen(false); setCursor(-1); };

  return (
    <div className="suggest" ref={box}>
      <div className="suggest-field">
      <input
        id={id}
        name={name}
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setCursor(-1); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); return; }
          if (e.key === 'ArrowDown') {
            e.preventDefault(); setOpen(true);
            setCursor((c) => Math.min(c + 1, found.length - 1));
          }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, -1)); }
          // Enter выбирает подсказку, только когда она подсвечена. Иначе
          // Enter делает то же, что всегда, — отправляет форму: агент,
          // набравший своё название, не должен ловить чужое.
          if (e.key === 'Enter' && cursor >= 0 && found[cursor]) {
            e.preventDefault(); pick(found[cursor]);
          }
        }}
      />

      {open && found.length > 0 ? (
        <div className="pick-pop suggest-pop">
          <div className="pick-list" role="listbox" ref={list}>
            {found.map((o, i) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === value}
                data-at={i === cursor ? 'true' : undefined}
                className="pick-row"
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(o)}
              >
                <span>{o}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      </div>

      {/* Подпись появляется, только когда подсказать нечего: пока в
          списке что-то есть, человек ещё печатает, и говорить ему, что
          названия нет, рано. */}
      {hint && value.trim() !== '' && !exact && found.length === 0
        ? <p className="key">{hint}</p> : null}
    </div>
  );
}
