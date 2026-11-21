'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LANGS, LANG_NAMES, isLang, type Lang } from '@/lib/i18n';

/**
 * Выбор языка: глобус и текущий язык, по нажатию — список из четырёх.
 *
 * Переключение сохраняет страницу и фильтры: меняется только первый
 * участок пути. Человек, листавший третью страницу двушек до 60 000,
 * не должен после смены языка начинать поиск заново.
 *
 * Список, а не круговое переключение по нажатию: языков четыре, и
 * доходить до китайского тремя нажатиями — издевательство.
 */
export function LangSwitcher({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // Нажатие мимо и Escape закрывают список. Без этого он остаётся висеть
  // поверх каталога, и его приходится закрывать тем же глобусом.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Тот же адрес на другом языке. */
  const to = (next: Lang) => {
    const parts = (pathname || '/').split('/').filter(Boolean);
    if (isLang(parts[0])) parts[0] = next;
    else parts.unshift(next);
    return `/${parts.join('/')}${search ? `?${search}` : ''}`;
  };

  return (
    <div className="lang" ref={box}>
      <button
        type="button"
        className="lang-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Язык: ${LANG_NAMES[lang]}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Globe />
        <span className="lang-now">{lang.toUpperCase()}</span>
      </button>

      {open ? (
        <ul className="lang-menu" role="listbox">
          {LANGS.map((l) => (
            <li key={l} role="option" aria-selected={l === lang}>
              <Link
                href={to(l)}
                hrefLang={l}
                className={l === lang ? 'on' : undefined}
                onClick={() => setOpen(false)}
              >
                {LANG_NAMES[l]}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Глобус. Меридианы дугами, а не прямыми: так шар читается шаром. */
function Globe() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.4 10h15.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 2.4c2.4 2.1 3.6 4.6 3.6 7.6S12.4 15.5 10 17.6C7.6 15.5 6.4 13 6.4 10S7.6 4.5 10 2.4Z"
            stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
