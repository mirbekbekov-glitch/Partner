'use client';

import { useEffect, useRef } from 'react';

/**
 * Фон героя: ступенчатая диагональ и свет, идущий за курсором.
 *
 * Ступенька — не произвольная фигура, а мотив из знака агентства: в нём
 * квадраты сложены лесенкой. Обычная косая полоса есть у всех; лесенка
 * есть только здесь, и она повторяется в метке на карточке и в маркерах
 * списка. Это и даёт странице лицо: один мотив, проведённый через всё.
 *
 * Свет за курсором — не украшение ради украшения: он делает большое
 * тёмное поле отзывчивым, и страница перестаёт выглядеть картинкой. На
 * телефоне указателя нет, и там его нет тоже; при включённом «меньше
 * движения» он выключается.
 */
export function HeroArt() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;

    let raf = 0;
    const onMove = (e: PointerEvent) => {
      // Координаты пишем в переменные CSS и только в кадре отрисовки:
      // pointermove приходит чаще, чем экран успевает обновиться.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    };
    const parent = el.parentElement ?? el;
    parent.addEventListener('pointermove', onMove);
    return () => {
      parent.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="hero-art" ref={box} aria-hidden="true">
      <div className="hero-glow" />
      <svg viewBox="0 0 600 620" preserveAspectRatio="xMaxYMid slice">
        <defs>
          <linearGradient id="stair-red" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#E0453F" />
            <stop offset="1" stopColor="#7E1B19" />
          </linearGradient>
        </defs>
        {/* Тёмная лесенка позади — она даёт глубину, а не второй цвет. */}
        <path d={stairs(150, 14)} fill="#12161C" />
        <path d={stairs(300, 14)} fill="url(#stair-red)" />
      </svg>
    </div>
  );
}

/**
 * Лесенка: фигура, у которой левый край идёт ступенями сверху вниз, а
 * правый уходит за кадр. `x` — где начинается верхняя ступень,
 * `n` — сколько ступеней.
 */
function stairs(x: number, n: number): string {
  const W = 700;
  const H = 620;
  const step = H / n;
  const run = 26;
  const p: string[] = [`M ${W} -20`, `L ${x} -20`];
  for (let i = 0; i < n; i++) {
    p.push(`L ${x + i * run} ${-20 + (i + 1) * step}`);
    p.push(`L ${x + (i + 1) * run} ${-20 + (i + 1) * step}`);
  }
  p.push(`L ${W} ${H}`, 'Z');
  return p.join(' ');
}
