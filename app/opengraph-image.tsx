/**
 * Карточка для превью при пересылке: её видят в мессенджере и соцсети те,
 * кому отправили ссылку на каталог.
 *
 * Знак берётся настоящий — тот же файл, что стоит в шапке сайта. Раньше
 * здесь было слово «Liberterra», набранное шрифтом генератора: в Telegram
 * приходила чёрная плашка с чужой гарнитурой, и человек, которому прислали
 * ссылку, видел не наш знак, а похожий на него текст.
 *
 * Картинка приходит сюда через `?inline`, то есть байтами файла прямо в
 * сборке. Ссылкой на https://liberterra.kg/... её брать нельзя: карточку
 * рисует Worker, и это был бы поход в сеть во время отрисовки — лишний
 * отказ там, где он виден только чужому мессенджеру. Файл один и тот же,
 * поэтому знак на карточке не разойдётся со знаком на сайте.
 *
 * Полотно светлое, под знак в его исходном виде — красный целиком. Тёмная
 * версия знака существует (public/liberterra-dark.png), но она для тёмной
 * шапки сайта; в ленте мессенджера светлая карточка с красным знаком — это
 * ровно то, что человек видит, открыв сам сайт.
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
import logo from '../public/liberterra.png?inline';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export const alt = `${AGENCY_NAME} — real estate in Bishkek`;

// Пропорции файла — 664×144. Ширина знака на карточке выбрана так, чтобы
// он занимал примерно половину полотна: крупнее он упирается в край,
// мельче — снова становится марочкой в углу, из-за которой всё и затевалось.
const MARK = { width: 580, height: 126 };

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
          background: '#F0EDE8',
          color: '#1C1C1A',
          padding: '76px 80px',
        }}
      >
        <img src={logo} width={MARK.width} height={MARK.height} alt="" />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Слова отдельными блоками с заданным зазором: собственного
              пробела генератор на этом шрифте ставит разной ширины, и в
              одной строке это читается как опечатка. */}
          <div style={{ display: 'flex', gap: 14, fontSize: 52, fontWeight: 700,
                        letterSpacing: -1, color: '#1C1C1A' }}>
            <span>Real</span>
            <span>estate</span>
            <span>in</span>
            <span>Bishkek</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          {/* Та же красная черта, что отделяет разделы на сайте. */}
          <div style={{ display: 'flex', width: 72, height: 6, background: '#BE2C28' }} />
          <div style={{ display: 'flex', fontSize: 32, color: '#6B6B66' }}>
            {AGENCY_PHONES[0].display}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
