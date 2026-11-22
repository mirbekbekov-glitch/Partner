/**
 * Герой каталога.
 *
 * Рисунок — инлайновый SVG, а не картинка: он весит байты, масштабируется без
 * второго файла и перекрашивается теми же токенами, что остальной сайт. Это
 * «вариант А» из макета — лёгкая изометрическая графика; тяжёлый 3D-рендер
 * сюда не ставится, пока его некому держать в актуальном виде.
 */
export function Hero({ total }: { total: number }) {
  return (
    <section className="hero">
      <div className="hero-text">
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
          {total % 10 === 1 && total % 100 !== 11 ? "объект" : "объектов"} — и у
          каждого действующий договор с собственником. Дата рядом с ценой — это
          день, когда агент подтвердил, что цена и фотографии ещё в силе.
        </p>
      </div>

      <div className="hero-art" aria-hidden="true">
        <svg viewBox="0 0 420 320" role="presentation">
          <defs>
            <linearGradient id="lt-step" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--brand-bright)" />
              <stop offset="1" stopColor="var(--brand-deep)" />
            </linearGradient>
          </defs>
          {/* Изометрическая лестница: шесть маршей, каждый — три грани.
              Числа посчитаны один раз и собраны циклом, чтобы правка шага
              не превращалась в правку восемнадцати многоугольников. */}
          {Array.from({ length: 6 }, (_, i) => {
            const x = 70 + i * 40;
            const y = 250 - i * 34;
            const w = 40;
            const d = 22;
            return (
              <g key={i}>
                <polygon points={`${x},${y} ${x + w},${y - d / 2} ${x + w + d},${y + d / 2} ${x + d},${y + d}`}
                         fill="url(#lt-step)" opacity={0.92} />
                <polygon points={`${x + d},${y + d} ${x + w + d},${y + d / 2} ${x + w + d},${y + d / 2 + 40} ${x + d},${y + d + 40}`}
                         fill="var(--brand-deep)" opacity={0.85} />
                <polygon points={`${x},${y} ${x + d},${y + d} ${x + d},${y + d + 40} ${x},${y + 40}`}
                         fill="var(--brand)" opacity={0.55} />
              </g>
            );
          })}
          {/* Тонкая сетка позади — чертёжный мотив из макета. */}
          <g stroke="var(--line)" strokeWidth="1" fill="none" opacity="0.9">
            {Array.from({ length: 7 }, (_, i) => (
              <line key={`a${i}`} x1={20 + i * 60} y1="30" x2={20 + i * 60 - 40} y2="300" />
            ))}
            {Array.from({ length: 5 }, (_, i) => (
              <line key={`b${i}`} x1="10" y1={40 + i * 60} x2="410" y2={40 + i * 60 - 30} />
            ))}
          </g>
        </svg>
      </div>
    </section>
  );
}
