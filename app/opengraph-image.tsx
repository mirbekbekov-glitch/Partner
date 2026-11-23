/**
 * Карточка для превью при пересылке: её видят в мессенджере и соцсети те,
 * кому отправили ссылку на каталог.
 *
 * Знак из public/liberterra.png тут не подходит: он 664×144, а og требует
 * 1200×630 — узкую полоску мессенджер покажет марочкой в углу. Рисуем
 * карточку нужных пропорций.
 *
 * ВАЖНО: текст только латиницей и цифрами. Своего шрифта мы не передаём, а
 * встроенный в генератор покрывает латиницу — кириллица вышла бы пустыми
 * прямоугольниками. Подгрузить Manrope с Google Fonts нельзя: сборка идёт
 * в сети, где он недоступен (см. app/layout.tsx). Поэтому на карточке
 * каталога — имя агентства и город, а карточки объектов берут настоящую
 * фотографию объекта и в этом шрифте не нуждаются.
 */
import { ImageResponse } from 'next/og';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export const alt = `${AGENCY_NAME} — real estate in Bishkek`;

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0E1116',
          color: '#FFFFFF',
          padding: '72px 80px',
        }}
      >
        {/* Тонкая красная черта сверху — тот же акцент, что на сайте. */}
        <div style={{ display: 'flex', width: 160, height: 6, background: '#BE2C28' }} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 108, fontWeight: 700, letterSpacing: -2 }}>
            {AGENCY_NAME}
          </div>
          {/* Слова отдельными блоками с заданным зазором: собственного
              пробела генератор на этом шрифте ставит разной ширины, и в
              одной строке это читается как опечатка. */}
          <div style={{ display: 'flex', gap: 14, fontSize: 44, color: '#AEB5BF', marginTop: 12 }}>
            <span>Real</span>
            <span>estate</span>
            <span>in</span>
            <span>Bishkek</span>
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 32, color: '#8B929C' }}>
          {AGENCY_PHONES[0].display}
        </div>
      </div>
    ),
    size,
  );
}
