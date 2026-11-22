'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * Переключатель светлой и тёмной темы.
 *
 * Начальное состояние — системное: человек, у которого телефон в тёмной
 * теме, видит тёмный сайт сразу, не нажимая ничего. Нажатие переопределяет
 * системное и запоминается; выбор лежит в localStorage, а не в базе, и
 * потому не требует ни входа, ни согласия на хранение данных.
 *
 * Применяется выбор ДО первой отрисовки — крошечным скриптом в <head>
 * (см. app/layout.tsx). Если применять его здесь, в React, страница
 * успевала бы моргнуть светлой темой перед тёмной.
 */
export function ThemeSwitch({ label }: { label: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const set = document.documentElement.dataset.theme as Theme | undefined;
    setTheme(set ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);

  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* приватный режим */ }
    setTheme(next);
  };

  return (
    <button type="button" className="theme-btn" onClick={flip}
            aria-label={label} title={label}>
      {/* До того как тема определена, рисуем солнце: подменять значок
          после загрузки заметнее, чем показать не тот на долю секунды. */}
      {theme === 'dark' ? <Moon /> : <Sun />}
    </button>
  );
}

const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.6" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
      <line key={a} x1="10" y1="1.6" x2="10" y2="3.6" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round"
            transform={`rotate(${a} 10 10)`} />
    ))}
  </svg>
);

const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M16 12.4A7 7 0 0 1 7.6 4a7 7 0 1 0 8.4 8.4Z" stroke="currentColor"
          strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);
