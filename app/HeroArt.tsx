'use client';

import { useEffect, useRef } from 'react';

/**
 * Фон героя: человек поднимается по лестнице, и следующая ступень красная.
 *
 * Лестница — мотив из знака агентства, где квадраты сложены ступенями.
 *
 * Почему с человеком. Четыре подхода подряд — изометрия, сплошной марш
 * сбоку, столбики, консольные плиты — читались чем угодно: пандусом,
 * диаграммой роста, полками. Лестницей их делал не рисунок, а подпись к
 * нему. Фигура снимает вопрос мгновенно: там, где кто-то идёт по
 * ступеням, это ступени, под каким углом их ни рисуй.
 *
 * И она же говорит то, ради чего рисунок здесь стоит. Платформа — для
 * профессионалов: агент с ней поднимается на ступень выше, чем без неё.
 * Красная ступень — следующая, та, на которую он сейчас встанет; все
 * остальные графитовые. Один акцент на весь рисунок, и он стоит ровно
 * там, куда идёт нога.
 *
 * Ступени консольные: каждая висит в воздухе и отбрасывает мягкую тень.
 * Промежутки между ними не дают прочитать лестницу пандусом, а глубина —
 * мелкая и одинаковая у всех плит: ровно столько, чтобы плита стала
 * плитой, а не превратила рисунок обратно в изометрию.
 *
 * Фигура намеренно обобщённая: силуэт без лица, пола и возраста. Агентов
 * в Liberterra и мужчины, и женщины, и человек на первом экране должен
 * быть любым из них.
 *
 * Подъём показан, а не только нарисован: плиты встают снизу вверх, следом
 * появляется фигура. Движение одноразовое, при «меньше движения» его нет.
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
        <Climber />
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

/** На какой ступени человек стоит и на какую шагает. */
const STANDS = 1;
const NEXT = STANDS + 1;

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

/**
 * Человек на лестнице.
 *
 * Силуэт, а не фотография: фотография человека в костюме — это чужое
 * лицо на первом экране, лицензия на снимок и сотня килобайт. Силуэт
 * весит строчки, перекрашивается вместе с темой и никого собой не
 * изображает.
 *
 * Собран из отрезков с круглыми концами и одного корпуса. Пропорции
 * нарочно не анатомические: ступень здесь втрое выше настоящей, и
 * человек в масштабе 1:1 оказался бы вчетверо выше марша.
 */
const FIG = {
  /** Насколько фигура сдвинута вправо от начала своей ступени. */
  dx: 56,
  /** Масштаб: ступень условная, и фигура подогнана к ней, а не к жизни. */
  k: 1.25,
};
// Высота следующей ступени в местных единицах фигуры: передняя нога
// должна ВСТАТЬ на неё, а не повиснуть рядом.
const UP = -STEP_Y / FIG.k;

function Climber() {
  const ink = 'var(--figure)';
  const limb = (points: Array<[number, number]>, w: number) => (
    <polyline points={points.map((p) => p.join(',')).join(' ')} fill="none"
              stroke={ink} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
  );

  return (
    // Две группы, а не одна: внешняя двигается анимацией, внутренняя
    // ставит фигуру на ступень. Один transform на обе задачи не делится —
    // анимация, дойдя до «transform: none», стёрла бы и позицию, и
    // масштаб, и фигура прыгнула бы в угол рисунка.
    <g className="climber">
     <g transform={`translate(${stepX(STANDS) + FIG.dx} ${stepY(STANDS)}) scale(${FIG.k})`}>
      {/* Задняя нога — на своей ступени. */}
      {limb([[-5, -60], [-19, -32], [-23, -4]], 14)}
      <path d="M -31 -4 h 15 a 4.5 4.5 0 0 1 0 9 h -15 a 4.5 4.5 0 0 1 0 -9 z" fill={ink} />
      {/* Передняя нога — колено вперёд, стопа на красной ступени. */}
      {limb([[5, -60], [30, -50], [33, UP - 4]], 14)}
      <path d={`M 25 ${(UP - 5).toFixed(1)} h 17 a 4.5 4.5 0 0 1 0 9 h -17 a 4.5 4.5 0 0 1 0 -9 z`}
            fill={ink} />
      {/* Корпус: плечи шире бёдер, лёгкий наклон вперёд — человек идёт
          вверх, а не стоит. */}
      <path d="M -13 -106 L 14 -109 L 13 -58 L -9 -56 Z" fill={ink} />
      {limb([[-8, -101], [-21, -82], [-16, -62]], 11)}
      {limb([[9, -102], [23, -86], [27, -66]], 11)}
      <rect x={-2} y={-118} width={9} height={14} fill={ink} />
      <circle cx={3} cy={-125} r={10.5} fill={ink} />
     </g>
    </g>
  );
}
