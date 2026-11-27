'use client';

import { useEffect, useRef } from 'react';

/**
 * Фон героя: марш лестницы, который прочерчивают на глазах.
 *
 * Лестница — мотив из знака агентства, где квадраты сложены ступенями.
 *
 * Вид сбоку, а не в изометрии. Изометрия с остеклением читалась как
 * пандус: три грани, стекло и поручень давали узнаваемый предмет, но не
 * давали главного — что это ступени и что они ведут ВВЕРХ.
 *
 * И не столбики от пола. Шесть блоков, выстроенных по росту, с линиями
 * уровней и прямой диагональю поверх — это диаграмма роста, а не
 * лестница; на сайте агентства недвижимости она читалась бы как график
 * цен. Поэтому у марша есть низ: косая линия подшивки и воздух под ней.
 * Пустота под маршем и делает его маршем, а не гистограммой.
 *
 * Подъём не только нарисован, но и показан: контур прочерчивается от
 * нижней ступени к верхней, и следом проявляется сам марш. Глаз идёт за
 * остриём карандаша вверх — это доходит раньше, чем человек разберёт
 * рисунок. Движение одноразовое: на первом экране ему незачем
 * повторяться, а при «меньше движения» его нет вовсе.
 *
 * Собрана вектором, а не картинкой: режется на любом экране без мыла,
 * весит килобайты и перекрашивается вместе с темой.
 *
 * Марш чуть смещается за курсором — на несколько пикселей, в противоход.
 * Этого хватает, чтобы фон перестал быть наклейкой. На телефоне
 * указателя нет, при «меньше движения» смещение выключено.
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
          {/* Марш: сверху светлее, книзу уходит в тень — свет падает
              сверху слева, как и на остальном первом экране. */}
          <linearGradient id="flight" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="#E0453F" />
            <stop offset="1" stopColor="#9E1F1B" />
          </linearGradient>
          <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--art-ink)" stopOpacity=".16" />
            <stop offset="1" stopColor="var(--art-ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <Frame />
        {/* Тень на полу рисуется до марша: иначе ложится поверх него. */}
        <ellipse cx={X0 + (N * W) / 2} cy={Y0 + 9} rx={N * W * 0.56} ry="14"
                 fill="url(#shade)" />
        <Flight />
      </svg>
    </div>
  );
}

/* Марш ПОДНИМАЕТСЯ слева направо. Направление не декоративное: подъём
   читается как движение вверх, спуск — как вниз, и на первом экране
   агентства недвижимости нужен первый.

   Шесть ступеней, а не три и не двенадцать: на трёх подъём не успевает
   стать подъёмом, на двенадцати ступени мельчают до пилы. */
const N = 6;
const W = 62;     // проступь
const RISE = 44;  // подступёнок
const X0 = 70;
const Y0 = 400;   // уровень пола
const SLAB = 34;  // толщина марша у верхней площадки

const pt = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** Зубчатый верх: подступёнок — проступь — подступёнок, снизу вверх. */
function profile(): string[] {
  const p = [pt(X0, Y0)];
  for (let i = 0; i < N; i++) {
    p.push(pt(X0 + i * W, Y0 - (i + 1) * RISE));
    p.push(pt(X0 + (i + 1) * W, Y0 - (i + 1) * RISE));
  }
  return p;
}

function Flight() {
  const top = profile();
  const endX = X0 + N * W;
  const endY = Y0 - N * RISE;

  // Низ марша: торец у верхней площадки и косая подшивка обратно к полу.
  // Она начинается правее первого подступёнка — там, где марш и опирается
  // на пол; из-за этого под маршем остаётся воздух, а не столбики.
  const body = [
    ...top,
    pt(endX, endY + SLAB),
    pt(X0 + 44, Y0),
  ].join(' ');

  return (
    <>
      <polygon className="flight-fill" fill="url(#flight)" points={body} />
      {/* Контур прочерчивается по ступеням снизу вверх: карандаш идёт
          тем же путём, которым пошёл бы человек. */}
      {/* pathLength=1 приводит длину ломаной к единице, и пунктир в
          стилях задаётся точно, без подгонки под текущие размеры
          ступеней. С запасом «на глаз» линия прочерчивалась вчетверо
          быстрее задуманного: невидимый хвост съедал большую часть
          времени. */}
      <polyline className="flight-line" points={top.join(' ')} fill="none"
                pathLength={1}
                stroke="var(--accent)" strokeWidth="3"
                strokeLinecap="round" strokeLinejoin="round" />
      {/* Стрелка над верхней площадкой: марш продолжается за рисунком.
          Короткая и под углом самого марша — длинная прямая по кромкам
          ступеней превратила бы рисунок в график. */}
      <g className="rise-arrow" stroke="var(--accent)" strokeWidth="3"
         strokeLinecap="round" strokeLinejoin="round" fill="none">
        <line x1={endX + 10} y1={endY - 16} x2={endX + 52} y2={endY - 54} />
        <polyline points={`${endX + 30},${endY - 54} ${endX + 52},${endY - 54} ${endX + 52},${endY - 32}`} />
      </g>
    </>
  );
}

/**
 * Каркас: линии построения вокруг марша.
 *
 * Чертёж, а не украшение: пол, выносной размер подъёма и тонкие отметки
 * подступёнков. Так рисуют конструкцию до того, как её построят, — и это
 * ровно то, чем занимается агентство: показывает пространство, которого
 * человек ещё не видел.
 *
 * Горизонтальных линий уровня здесь намеренно нет. Шесть длинных линий
 * поперёк рисунка превращают любые столбики в диаграмму, а марш — в
 * график роста цен.
 *
 * Линии тонкие и серые, и они уходят ПОД красный объём: на чертеже
 * готовая деталь перекрывает построение, а не наоборот.
 */
function Frame() {
  const lines: React.ReactElement[] = [];
  const top = Y0 - N * RISE;

  // Пол, на котором стоит марш.
  lines.push(<line key="floor" x1={X0 - 46} y1={Y0} x2={X0 + N * W + 70} y2={Y0} />);

  // Выносной размер: высота всего подъёма, с засечками сверху и снизу.
  const hx = X0 - 32;
  lines.push(<line key="dim" x1={hx} y1={Y0} x2={hx} y2={top} />);
  lines.push(<line key="dim-a" x1={hx - 7} y1={Y0} x2={hx + 7} y2={Y0} />);
  lines.push(<line key="dim-b" x1={hx - 7} y1={top} x2={hx + 7} y2={top} />);

  // Отметки подступёнков: короткие вертикали от пола до своей ступени.
  // Короткие — чтобы остаться построением, а не решёткой диаграммы.
  for (let i = 1; i <= N; i++) {
    const x = X0 + i * W;
    lines.push(<line key={`v${i}`} x1={x} y1={Y0} x2={x} y2={Y0 - i * RISE - 18} />);
  }

  return (
    <g className="frame" strokeWidth="1" strokeLinecap="round">
      {lines}
    </g>
  );
}
