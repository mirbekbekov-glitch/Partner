'use client';

import { useEffect, useRef } from 'react';

/**
 * Фон героя: консольная лестница, у которой одна ступень красная.
 *
 * Лестница — мотив из знака агентства, где квадраты сложены ступенями.
 *
 * Ступени консольные: каждая висит в воздухе и отбрасывает мягкую тень.
 * Промежутки между ними не дают прочитать лестницу пандусом, а глубина —
 * мелкая и одинаковая у всех плит: ровно столько, чтобы плита стала
 * плитой, а не превратила рисунок обратно в изометрию.
 *
 * Нарисованной фигуры здесь нет. Она была и снята: силуэт, нарисованный
 * координатами, всё равно выглядит самодельным рядом с настоящей
 * типографикой, а чем ближе он к анатомии, тем заметнее швы. Место под
 * человека на этом рисунке есть — красная ступень стоит там, куда он
 * шагнёт, — но займёт его фотография, а не вектор.
 *
 * Подъём показан, а не только нарисован: плиты встают снизу вверх.
 * Движение одноразовое, при «меньше движения» его нет.
 *
 * Собрана вектором, а не картинкой: режется на любом экране без мыла,
 * весит килобайты и перекрашивается вместе с темой — на тёмном графит
 * сливался бы с фоном, поэтому цвета ступеней живут в переменных.
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
      <svg viewBox="0 0 560 470" preserveAspectRatio="xMidYMid meet">
        <defs>
          {/* Красная ступень. Светлее сверху — свет падает сверху слева,
              как и на остальном первом экране. */}
          <linearGradient id="red-top" x1="0" y1="1" x2="0.3" y2="0">
            <stop offset="0" stopColor="#E85A54" />
            <stop offset="1" stopColor="#C8322D" />
          </linearGradient>
          <linearGradient id="red-nose" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#A32320" />
            <stop offset="1" stopColor="#7C1613" />
          </linearGradient>
          {/* Мягкая тень: один проход фильтра на каждую плиту вместо
              стопки полупрозрачных копий. */}
          <filter id="soft" x="-40%" y="-40%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>
        <Stairs />
      </svg>
    </div>
  );
}

/* Лестница ПОДНИМАЕТСЯ слева направо. Направление не декоративное:
   подъём читается как движение вверх, спуск — как вниз, и на первом
   экране агентства недвижимости нужен первый. */
const N = 6;
const STEP_X = 58;  // смещение каждой следующей плиты вправо
const STEP_Y = 44;  // и вверх
const LEN = 112;    // длина плиты
const TH = 13;      // толщина
const DX = 30;      // глубина: вектор в правый верхний угол
const DY = -17;
const X0 = 56;
const Y0 = 396;

/**
 * Какая ступень красная.
 *
 * Третья снизу, а не первая и не последняя: на первой акцент совпал бы с
 * началом и читался бы как «отсюда», на последней — как «конец пути».
 * В середине подъёма он означает «следующая», то есть то, что и нужно.
 */
const NEXT = 2;

const pt = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;
const stepX = (i: number) => X0 + i * STEP_X;
const stepY = (i: number) => Y0 - i * STEP_Y;

function Stairs() {
  const slabs: React.ReactElement[] = [];

  for (let i = 0; i < N; i++) {
    const x = stepX(i);
    const y = stepY(i);
    const red = i === NEXT;

    slabs.push(
      <g key={i} className="slab" style={{ animationDelay: `${i * 70}ms` }}>
        {/* Тень падает ПОД плиту и повторяет её форму сверху: уехав
            вбок, она читалась бы не тенью, а пятном рядом. */}
        <g filter="url(#soft)">
          <polygon fill="var(--art-ink)" opacity=".17" points={[
            pt(x + 10, y + TH + 14), pt(x + LEN + 10, y + TH + 14),
            pt(x + LEN + DX + 10, y + DY + TH + 14), pt(x + DX + 10, y + DY + TH + 14),
          ].join(' ')} />
        </g>
        {/* Проступь — верхняя грань, по ней идут. */}
        <polygon fill={red ? 'url(#red-top)' : 'var(--step-top)'} points={[
          pt(x, y), pt(x + LEN, y), pt(x + LEN + DX, y + DY), pt(x + DX, y + DY),
        ].join(' ')} />
        {/* Торец: без него плита — плоский четырёхугольник. */}
        <polygon fill={red ? 'url(#red-nose)' : 'var(--step-nose)'} points={[
          pt(x, y), pt(x + LEN, y), pt(x + LEN, y + TH), pt(x, y + TH),
        ].join(' ')} />
        {/* Боковой срез уходит в глубину. */}
        <polygon fill={red ? '#6E1310' : 'var(--step-side)'} points={[
          pt(x + LEN, y), pt(x + LEN + DX, y + DY),
          pt(x + LEN + DX, y + DY + TH), pt(x + LEN, y + TH),
        ].join(' ')} />
      </g>,
    );
  }

  return <>{slabs}</>;
}
