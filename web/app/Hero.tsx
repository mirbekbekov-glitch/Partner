/**
 * Герой каталога.
 *
 * Рисунок — инлайновый SVG, а не картинка: он весит байты, масштабируется без
 * второго файла и перекрашивается теми же токенами, что остальной сайт.
 *
 * Это «вариант А» из макета — лёгкая чертёжная графика: светлая платформа с
 * сеткой, лестница с красными ступенями и тонкая линия перил. Тяжёлый
 * 3D-рендер сюда не ставится, пока его некому держать в актуальном виде:
 * картинка, которая через месяц разойдётся со стилем, хуже её отсутствия.
 *
 * ГЕОМЕТРИЯ. Изометрия задана тремя векторами, а не набором чисел в каждом
 * многоугольнике: F — вдоль марша, W — поперёк, подъём — по вертикали. Первая
 * версия рисовала «проступь» наклонной вдоль марша, и лестница выходила
 * пилой: у настоящей лестницы проступь горизонтальна, а подступёнок
 * вертикален, и видно это только на рисунке.
 */

const STEPS = 7;
const F: [number, number] = [24, 12]; // вдоль марша: вправо и вниз
const W: [number, number] = [34, -17]; // поперёк марша: вправо и вверх
const RISE = 26; // высота ступени
const ORIGIN: [number, number] = [86, 248];

const add = (...v: [number, number][]): [number, number] =>
  v.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
const mul = (v: [number, number], k: number): [number, number] => [v[0] * k, v[1] * k];
const p = (v: [number, number]) => `${v[0].toFixed(1)},${v[1].toFixed(1)}`;

export function Hero({ total }: { total: number }) {
  const treads: string[] = [];
  const risers: string[] = [];
  const rail: string[] = [];

  for (let i = 0; i < STEPS; i += 1) {
    // Левый ближний угол i-й ступени: i шагов вдоль марша и i подъёмов вверх.
    const base = add(ORIGIN, mul(F, i), [0, -RISE * i]);

    treads.push(
      [base, add(base, F), add(base, F, W), add(base, W)].map(p).join(" "),
    );

    const front = add(base, F);
    risers.push(
      [
        front,
        add(front, W),
        add(front, W, [0, RISE]),
        add(front, [0, RISE]),
      ]
        .map(p)
        .join(" "),
    );

    // Перила идут над дальним краем ступеней.
    rail.push(p(add(base, W, [0, -30])));
    if (i === STEPS - 1) rail.push(p(add(base, F, W, [0, -30 - RISE])));
  }

  const platform = [
    add(ORIGIN, [-46, 0]),
    add(ORIGIN, W, [-46, 0]),
    add(ORIGIN, mul(F, 2), W, [0, 0]),
    add(ORIGIN, mul(F, 2)),
  ]
    .map(p)
    .join(" ");

  return (
    <section className="hero">
      <p className="kicker">Liberterra · Бишкек</p>
      <h1>
        Найди своё пространство
        <br />
        для комфортной
        <br />
        <em>работы и жилья</em>
      </h1>
      <p className="hero-lead">
        В каталоге {total}{" "}
        {total % 10 === 1 && total % 100 !== 11 ? "объект" : "объектов"}, и у
        каждого действующий договор с собственником. Дата рядом с ценой — это
        день, когда агент подтвердил, что цена и фотографии ещё в силе.
      </p>

      <div className="hero-art" aria-hidden="true">
        <svg viewBox="0 0 340 290" role="presentation">
          {/* Площадка у основания с чертёжной сеткой. */}
          <polygon points={platform} fill="var(--chip)" opacity="0.6" />
          <g stroke="var(--line)" strokeWidth="1" fill="none">
            {Array.from({ length: 5 }, (_, i) => {
              const a = add(ORIGIN, [-46 + i * 18, 0]);
              return <line key={i} x1={a[0]} y1={a[1]} x2={a[0] + W[0]} y2={a[1] + W[1]} />;
            })}
          </g>

          {risers.map((points, i) => (
            <polygon key={`r${i}`} points={points} fill="var(--brand-deep)" />
          ))}
          {treads.map((points, i) => (
            <polygon
              key={`t${i}`}
              points={points}
              fill="var(--brand)"
              stroke="var(--brand-deep)"
              strokeWidth="0.6"
            />
          ))}

          {/* Перила одной линией: она и ведёт взгляд вверх. */}
          <polyline
            points={rail.join(" ")}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </section>
  );
}
