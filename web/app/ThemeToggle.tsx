"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Переключатель темы.
 *
 * По умолчанию тема берётся у системы — это `@media (prefers-color-scheme)`,
 * и в разметке для неё ничего не нужно. Кнопка нужна тем, у кого система
 * говорит одно, а глазам нужно другое: она ставит `data-theme` на `<html>` и
 * запоминает выбор.
 *
 * Выбор запоминается в localStorage, и обращение к нему обёрнуто в try: в
 * приватном окне и при запрещённых данных сайта он бросает исключение, и
 * страница не должна из-за этого падать.
 *
 * До первого рендера на клиенте кнопка молчит о состоянии: иначе сервер
 * нарисовал бы одно, клиент другое, и React пожаловался бы на расхождение.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem("lt-theme");
    } catch {
      saved = null;
    }
    const system = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    setTheme(saved === "dark" || saved === "light" ? saved : system);
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("lt-theme", theme);
    } catch {
      /* приватное окно: тема останется на эту вкладку */
    }
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <circle cx="10" cy="10" r="4" fill="currentColor" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            return (
              <line
                key={i}
                x1={10 + Math.cos(a) * 6.5}
                y1={10 + Math.sin(a) * 6.5}
                x2={10 + Math.cos(a) * 8.5}
                y2={10 + Math.sin(a) * 8.5}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <path
            d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
