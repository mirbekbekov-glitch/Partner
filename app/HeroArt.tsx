'use client';

import { useEffect, useRef } from 'react';

/**
 * Фон героя: объёмная лестница и свет, идущий за курсором.
 *
 * Лестница — мотив из знака агентства, где квадраты сложены ступенями.
 * Здесь она построена в изометрии: у каждой ступени видны проступь,
 * подступёнок и боковина, и они окрашены по-разному — как если бы свет
 * падал сверху слева. Именно разные грани, а не контур, дают объём.
 *
 * Собрана вектором, а не картинкой: режется на любом экране без мыла,
 * весит килобайты и перекрашивается вместе с темой. Трёхмерный рендер
 * пришлось бы грузить отдельным файлом и готовить под каждую плотность.
 *
 * Лестница чуть смещается за курсором — на несколько пикселей, в
 * противоход. Этого хватает, чтобы фон перестал быть наклейкой. На
 * телефоне указателя нет, при «меньше движения» смещение выключено.
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
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        el.style.setProperty('--mx', `${x}px`);
        el.style.setProperty('--my', `${y}px`);
        // Сдвиг в противоход курсору и в десять раз слабее: предмет
        // отзывается, но не убегает.
        el.style.setProperty('--px', `${(0.5 - x / r.width) * 18}px`);
        el.style.setProperty('--py', `${(0.5 - y / r.height) * 12}px`);
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
      <svg viewBox="0 0 470 470" preserveAspectRatio="xMidYMid meet">
        <defs>
          {/* Три грани — три заливки. Проступь светлее всех: на неё падает
              свет. Подступёнок в тени, боковина между ними. */}
          <linearGradient id="tread" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F4645E" /><stop offset="1" stopColor="#D83B35" />
          </linearGradient>
          <linearGradient id="riser" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#B82722" /><stop offset="1" stopColor="#8E1B17" />
          </linearGradient>
          <linearGradient id="side" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6E1512" /><stop offset="1" stopColor="#4C0E0C" />
          </linearGradient>
          <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--art-ink)" stopOpacity=".18" />
            <stop offset="1" stopColor="var(--art-ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Тень на полу рисуется до лестницы: иначе ложится поверх плиты. */}
        <ellipse cx="230" cy="404" rx="200" ry="20" fill="url(#shade)" />
        <Stairs />
      </svg>
    </div>
  );
}

/* Изометрия: лестница ПОДНИМАЕТСЯ слева направо. Направление не
   декоративное: подъём читается как движение вверх, спуск — как вниз, и
   на первом экране агентства недвижимости нужен первый.
   d = (DX, DY) — вектор глубины: он уводит в правый верхний угол, поэтому
   видны проступи сверху и правая боковина. */
const RUN = 58;
const RISE = 46;
const DX = 56;
const DY = -32;
const N = 5;
const X0 = 52;
const Y0 = 396;   // уровень пола

const pt = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

function Stairs() {
  const right = X0 + N * RUN;
  const top = Y0 - N * RISE;

  // Ступенчатый силуэт передней стенки: от пола вверх уступами и вниз по
  // правому краю обратно к полу.
  const front: string[] = [pt(X0, Y0)];
  for (let i = 0; i < N; i++) {
    front.push(pt(X0 + i * RUN, Y0 - (i + 1) * RISE));
    front.push(pt(X0 + (i + 1) * RUN, Y0 - (i + 1) * RISE));
  }
  front.push(pt(right, Y0));

  // Проступи — площадки, по которым идут. Светлее всего: на них падает свет.
  const treads = Array.from({ length: N }, (_, i) => {
    const y = Y0 - (i + 1) * RISE;
    const x = X0 + i * RUN;
    return (
      <polygon key={i} fill="url(#tread)"
        points={[pt(x, y), pt(x + RUN, y), pt(x + RUN + DX, y + DY), pt(x + DX, y + DY)].join(' ')} />
    );
  });

  return (
    <>
      {/* Правая боковина уходит в глубину — она темнее всех. */}
      <polygon fill="url(#side)"
        points={[pt(right, top), pt(right + DX, top + DY),
                 pt(right + DX, Y0 + DY), pt(right, Y0)].join(' ')} />
      {treads}
      <polygon fill="url(#riser)" points={front.join(' ')} />
    </>
  );
}
