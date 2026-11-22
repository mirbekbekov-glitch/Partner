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
      {/* Поле шире высоты: призрак следующего марша уходит вправо-вверх,
            и в квадрате он обрезался. */}
      <svg viewBox="0 0 560 470" preserveAspectRatio="xMidYMid meet">
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
          {/* Торец плиты: узкая грань, её видно снизу, и она темнее
              проступи, но светлее боковины. */}
          <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#C3302B" /><stop offset="1" stopColor="#9A211C" />
          </linearGradient>
          {/* Стекло ограждения: почти прозрачное, с лёгким холодным
              оттенком — иначе читается как грязь, а не как стекло. */}
          <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9FB4C2" stopOpacity=".30" />
            <stop offset="1" stopColor="#9FB4C2" stopOpacity=".12" />
          </linearGradient>
          <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--art-ink)" stopOpacity=".18" />
            <stop offset="1" stopColor="var(--art-ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <Frame />
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
const TH = 12;    // толщина плиты
const RAIL = 92;  // высота ограждения
const N = 5;
const X0 = 52;
const Y0 = 396;   // уровень пола

const pt = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

function Stairs() {
  const slabs: React.ReactElement[] = [];

  // От дальней ступени к ближней: ближняя перекрывает дальнюю, и порядок
  // отрисовки заменяет расчёт видимости.
  for (let i = N - 1; i >= 0; i--) {
    const x = X0 + i * RUN;
    const y = Y0 - i * RISE;

    // Проступь: площадка, по которой идут. Светлее всех — на неё падает свет.
    slabs.push(
      <polygon key={`t${i}`} fill="url(#tread)"
        points={[pt(x, y), pt(x + RUN, y), pt(x + RUN + DX, y + DY), pt(x + DX, y + DY)].join(' ')} />,
    );
    // Торец — передняя кромка плиты. Её толщина и делает ступень плитой,
    // а не плоским прямоугольником.
    slabs.push(
      <polygon key={`e${i}`} fill="url(#edge)"
        points={[pt(x, y), pt(x + RUN, y), pt(x + RUN, y + TH), pt(x, y + TH)].join(' ')} />,
    );
    // Правая боковина уходит в глубину — самая тёмная грань.
    slabs.push(
      <polygon key={`s${i}`} fill="url(#side)"
        points={[pt(x + RUN, y), pt(x + RUN + DX, y + DY),
                 pt(x + RUN + DX, y + DY + TH), pt(x + RUN, y + TH)].join(' ')} />,
    );
  }

  // Стекло ограждения по дальней стороне. Рисуется ДО ступеней: стекло
  // стоит за ними, и ступени должны оставаться резкими.
  const gx1 = X0 + DX;
  const gy1 = Y0 + DY;
  const gx2 = X0 + N * RUN + DX;
  const gy2 = Y0 - (N - 1) * RISE + DY;
  const glass = [
    pt(gx1, gy1), pt(gx2, gy2),
    pt(gx2, gy2 - RAIL), pt(gx1, gy1 - RAIL),
  ].join(' ');

  return (
    <>
      <polygon fill="url(#glass)" points={glass} />
      {/* Поручень: тонкая линия поверх стекла. Без неё стекло выглядит
          случайным пятном, а не ограждением. */}
      <line x1={gx1} y1={gy1 - RAIL} x2={gx2} y2={gy2 - RAIL}
            stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
      {slabs}
    </>
  );
}

/**
 * Каркас: линии построения вокруг лестницы.
 *
 * Чертёж, а не украшение: изометрическая сетка пола, призрак следующего
 * марша и выносные линии с засечками. Так рисуют конструкцию до того, как
 * её построят, — и это ровно то, чем занимается агентство: показывает
 * пространство, которого человек ещё не видел.
 *
 * Линии тонкие и серые, и они уходят ПОД красный объём: на чертеже
 * готовая деталь перекрывает построение, а не наоборот.
 */
function Frame() {
  const right = X0 + N * RUN;
  const top = Y0 - N * RISE;
  const lines: React.ReactElement[] = [];

  // Сетка пола в изометрии: две семьи параллельных линий.
  for (let i = 0; i <= 7; i++) {
    const x = X0 - 40 + i * RUN;
    lines.push(
      <line key={`a${i}`} x1={x} y1={Y0} x2={x + DX * 2.2} y2={Y0 + DY * 2.2} />,
    );
  }
  for (let j = 0; j <= 4; j++) {
    const k = j / 4;
    lines.push(
      <line key={`b${j}`}
        x1={X0 - 40 + DX * 2.2 * k} y1={Y0 + DY * 2.2 * k}
        x2={X0 - 40 + 7 * RUN + DX * 2.2 * k} y2={Y0 + DY * 2.2 * k} />,
    );
  }

  // Призрак следующего марша: лестница продолжается вверх-вправо.
  const ghost: string[] = [pt(right, top)];
  for (let i = 0; i < 2; i++) {
    ghost.push(pt(right + i * RUN, top - (i + 1) * RISE));
    ghost.push(pt(right + (i + 1) * RUN, top - (i + 1) * RISE));
  }
  lines.push(<polyline key="ghost" points={ghost.join(' ')} fill="none" />);
  lines.push(
    <polyline key="ghost-d" fill="none"
      points={[pt(right + DX, top + DY),
               pt(right + DX, top + DY - 2 * RISE),
               pt(right + DX + 2 * RUN, top + DY - 2 * RISE)].join(' ')} />,
  );

  // Выносная линия с засечками — высота подъёма.
  const hx = X0 - 26;
  lines.push(<line key="dim" x1={hx} y1={Y0} x2={hx} y2={top} />);
  lines.push(<line key="dim-a" x1={hx - 6} y1={Y0} x2={hx + 6} y2={Y0} />);
  lines.push(<line key="dim-b" x1={hx - 6} y1={top} x2={hx + 6} y2={top} />);

  return (
    <g className="frame" strokeWidth="1" strokeLinecap="round">
      {lines}
    </g>
  );
}
