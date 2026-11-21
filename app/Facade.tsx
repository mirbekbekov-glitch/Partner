/**
 * Рисованный фасад вместо фотографии.
 *
 * Объект без фото — обычное дело: агент завёл его с телефона и снимки
 * добавит позже. Серый прямоугольник в сетке читается как поломка, поэтому
 * рисуем дом.
 *
 * Рисунок строится из САМИХ ДАННЫХ объекта: этажность задаёт высоту,
 * комнаты — число окон, площадь — ширину. Поэтому дома в каталоге
 * отличаются друг от друга тем же, чем отличаются объекты, а не случайным
 * шумом. Цвета берутся из тем, значит фасад одинаково уместен на светлой и
 * тёмной.
 */
export type FacadeInput = {
  id: string;
  kind: string;
  rooms: number | null;
  area: number | null;
  floors_total: number | null;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function Facade({ o, variant = 0, alt }: { o: FacadeInput; variant?: number; alt?: string }) {
  // Устойчивое число из uuid: один и тот же объект всегда рисуется одинаково.
  const seed = [...o.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7) + variant * 131;
  const wall = ['var(--wall)', 'var(--wall-2)', 'var(--wall-3)'][seed % 3];
  const sky = `sky-${o.id}-${variant}`;
  // Подпись приходит с языком страницы: раньше она была по-русски
  // даже на китайской версии.
  const label = alt ?? 'Рисунок вместо фотографии';

  let inner: React.ReactNode = null;

  if (o.kind === 'land') {
    inner = (
      <>
        <path d="M20 150 L300 136 L300 206 L20 220 Z" fill={wall} opacity=".75" />
        {[60, 130, 210, 265].map((x, i) => (
          <g key={x} transform={`translate(${x} ${150 + (i % 2) * 14})`}>
            <rect x="-2" y="0" width="4" height="26" fill="var(--wall-dark)" />
            <circle cx="0" cy="-6" r={13 + i * 2} fill="var(--glass)" opacity=".55" />
          </g>
        ))}
        {Array.from({ length: 9 }, (_, i) => (
          <rect key={i} x={18 + i * 34} y={140 + i * 2} width="3" height="18"
                fill="var(--wall-dark)" opacity=".6" />
        ))}
      </>
    );
  } else if (o.kind === 'house' || o.kind === 'townhouse') {
    inner = (
      <>
        <path d="M64 120 L160 66 L256 120 Z" fill="var(--wall-dark)" />
        <rect x="78" y="118" width="164" height="100" fill={wall} />
        <rect x="146" y="166" width="30" height="52" fill="var(--wall-dark)" opacity=".8" />
        {[0, 1].map((r) => [0, 1].map((c) => (
          <rect key={`${r}-${c}`} x={96 + c * 86} y={136 + r * 40} width="30" height="26" rx="2"
                fill="var(--glass)" opacity={0.5 + ((r + c + seed) % 3) * 0.14} />
        )))}
        <rect x="0" y="218" width="320" height="22" fill="var(--wall-dark)" opacity=".45" />
      </>
    );
  } else {
    const cols = clamp((o.rooms ?? 2) + 1, 2, 5);
    const rows = clamp(o.floors_total ?? 3, 2, 5);
    const w = o.kind === 'commercial' ? 264 : Math.round(150 + clamp(o.area ?? 60, 20, 120) * 0.45);
    const x0 = (320 - w) / 2;
    const top = Math.max(48, 220 - (rows * 38 + 20));
    const cw = (w - 24) / cols - 10;
    inner = (
      <>
        {/* Соседние дома: без них здание висит в пустоте. */}
        <rect x={x0 - 38} y={top + 34} width="34" height={220 - top - 34}
              fill="var(--wall-dark)" opacity=".35" />
        <rect x={x0 + w + 6} y={top + 52} width="28" height={220 - top - 52}
              fill="var(--wall-dark)" opacity=".28" />
        <rect x={x0} y={top} width={w} height={220 - top} fill={wall} />
        <rect x={x0} y={top} width={w} height="8" fill="var(--wall-dark)" />
        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => (
            <rect key={`${r}-${c}`} x={x0 + 12 + c * (cw + 10)} y={top + 20 + r * 38}
                  width={cw} height="26" rx="2" fill="var(--glass)"
                  opacity={0.5 + ((r * 3 + c * 5 + seed) % 4) * 0.13} />
          )),
        )}
        {o.kind === 'commercial' ? (
          <rect x={x0 + 12} y="176" width={w - 24} height="44" rx="2" fill="var(--glass)" opacity=".85" />
        ) : (
          <rect x={x0 + w / 2 - 16} y="186" width="32" height="34" fill="var(--wall-dark)" opacity=".8" />
        )}
        <rect x="0" y="220" width="320" height="20" fill="var(--wall-dark)" opacity=".45" />
      </>
    );
  }

  return (
    <svg viewBox="0 0 320 240" role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--sky-1)" />
          <stop offset="100%" stopColor="var(--sky-2)" />
        </linearGradient>
      </defs>
      <rect width="320" height="240" fill={`url(#${sky})`} />
      <circle cx={40 + (seed % 60)} cy="46" r={16 + (seed % 8)} fill="var(--sky-1)" opacity=".7" />
      {inner}
    </svg>
  );
}
