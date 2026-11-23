/**
 * Посадочная страница печатного QR-кода «Чайка».
 *
 * Почему адрес /chaika-resort, а не /chayka. Печатные коды ведут на
 * /chayka, и этот путь занят чужим Worker qr-redirect: он считает
 * сканирования в Google-таблицу, и сбивать счёт нельзя. Он же решает, куда
 * отправить человека — адрес лежит в той же таблице, строка «chayka».
 *
 * Цепочка: QR → /chayka → qr-redirect считает скан → сюда.
 *
 * Имя намеренно не похоже на chayka: маршрут чужого Worker ловит /chayka*
 * по маске, и страница на /chayka-dom попала бы в петлю сама на себя.
 *
 * Без языкового префикса — по той же причине, по какой текст только
 * русский.
 *
 * Почему только по-русски. Правило проекта: подписи интерфейса переводятся,
 * а текст об объекте пишет агент своими словами и машинного перевода тут не
 * будет (см. lib/i18n.ts). Описание дома — как раз такой текст: цена ошибки
 * в нём слишком велика, чтобы доверять её переводчику.
 *
 * Всё, что написано ниже про дом, получено от агентства. Ничего не добавлено
 * «для красоты»: объявление о недвижимости — обещание покупателю.
 */
import type { Metadata } from 'next';
import { CatalogHeader } from '../CatalogHeader';
import { CatalogFooter } from '../CatalogFooter';
import { ChaikaForm } from '../ChaikaForm';
import { AGENCY_PHONES } from '@/lib/agency';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

/** Метка для поля source в заявке: по ней видно, что сработал печатный код. */
const SOURCE = 'chayka-qr';

const REEL = 'https://www.instagram.com/reel/DfjNYukOWEl/';

/** Объявление на Airbnb: подтверждение, что арендный бизнес не на словах. */
const AIRBNB = 'https://www.airbnb.ru/rooms/1420997659375471402';

/**
 * Фотографии. Подписи описывают то, что на снимке, а не рекламируют: alt
 * читает экранный диктор и показывает браузер, когда картинка не
 * загрузилась, — приукрашивать тут некого и незачем.
 *
 * Размеры заданы явно: без них страница прыгает, пока грузятся снимки.
 */
const PHOTOS: { src: string; alt: string; w: number; h: number }[] = [
  { src: '/chaika/dom-s-vysoty.webp', w: 1600, h: 863,
    alt: 'Два дома комплекса с высоты, за ними полоса деревьев и пляж' },
  { src: '/chaika/gostinaya.webp', w: 1032, h: 778,
    alt: 'Гостиная: два дивана, телевизор, в глубине кухня-столовая' },
  { src: '/chaika/kuhnya-stolovaya.webp', w: 1036, h: 778,
    alt: 'Кухня со встроенной техникой и обеденный стол у окна' },
  { src: '/chaika/vyhod-v-sad.webp', w: 578, h: 778,
    alt: 'Обеденная зона у панорамной двери с выходом во двор' },
  { src: '/chaika/spalnya.webp', w: 590, h: 778,
    alt: 'Спальня с двуспальной кроватью и окном во всю стену' },
  { src: '/chaika/spalnya-kabinet.webp', w: 590, h: 698,
    alt: 'Спальня с рабочим столом и выходом на балкон' },
  { src: '/chaika/terrasa.webp', w: 1032, h: 778,
    alt: 'Крытая терраса второго этажа, за перилами деревья, пляж и озеро' },
  { src: '/chaika/kompleks.webp', w: 1216, h: 969,
    alt: 'Территория комплекса с высоты, на горизонте снежные горы' },
  { src: '/chaika/plyazh.webp', w: 1200, h: 887,
    alt: 'Пляж и бухта Иссык-Куля на закате' },
  { src: '/chaika/raspolozhenie.webp', w: 1200, h: 644,
    alt: 'Расположение комплекса относительно пляжа, с высоты' },
];

/** Коммерческое предложение агентства — тот же дом, одним файлом. */
const KP = '/chaika/kp-dupleks-chaika-resort.pdf';

const TITLE = 'Дуплекс в Chaika Resort на Иссык-Куле — 550 000 $';
const DESCRIPTION =
  'Премиальный дуплекс 178 м² на территории Chaika Resort: 7 комнат, 5 спален, '
  + 'приватный двор 312,5 м², вторая линия от озера, мебель и техника. '
  + 'Работающий арендный бизнес на Airbnb.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/chaika-resort' },
  openGraph: {
    type: 'website',
    url: siteUrl('/chaika-resort'),
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: siteUrl('/chaika/og.jpg'), width: 1200, height: 630,
               alt: 'Дом в Chaika Resort с высоты' }],
  },
};

/**
 * Характеристики: только то, что сообщило агентство.
 *
 * Ровно пять: плитка выкладывается рядами, и шестая повисала бы одна с
 * пустым полем рядом. Парковка не потерялась — она в списке территории.
 *
 * «Спален 5» — из коммерческого предложения агентства, где это число стоит
 * дважды. С поэтажным описанием оно сходится: три спальни наверху и две
 * комнаты внизу. Первый текст объявления называл только три — на странице
 * цифра агентства, потому что её же увидит покупатель в присланном файле.
 */
const SPECS: [string, string][] = [
  ['Площадь дома', '178 м²'],
  ['Участок', '312,5 м²'],
  ['Этажей', '2'],
  ['Комнат', '7'],
  ['Спален', '5'],
];

const FLOOR_1 = [
  'Просторная гостиная, объединённая с кухней',
  'Две дополнительные комнаты',
  'Гостевой санузел',
  'Выход в приватный зелёный двор',
];

const FLOOR_2 = [
  'Три спальни',
  'Master bedroom с собственным санузлом и душем',
  'Отдельный санузел с душем',
  'Спальня с балконом и видом на озеро',
];

const RESORT = [
  'Ресторан', 'Бар', 'Детская площадка', 'Футбольное поле',
  'Баскетбольная площадка', 'Теннисный корт', 'Охрана',
  'Ухоженная территория', 'Бесплатная парковка',
];

export default function ChaikaResortPage() {
  return (
    <>
      <CatalogHeader lang="ru" />

      <div className="wrap">
        <div className="detail">
          <div>
            {/* Один снимок сверху, остальные ниже отдельным разделом.
                Шесть фотографий подряд уводили цену и площадь за пределы
                экрана: человек сначала должен понять, что ему показывают и
                почём, и только потом разглядывать. */}
            <div className="gallery">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={PHOTOS[0].src} alt={PHOTOS[0].alt}
                   width={PHOTOS[0].w} height={PHOTOS[0].h}
                   className="shot lead" />
            </div>

            <div className="dhead">
              <h1>Дуплекс в Chaika Resort на Иссык-Куле</h1>
              <p className="sub">
                Вторая линия от озера · до пляжа несколько шагов · вид на озеро
                со второго этажа
              </p>
              <p className="price-big num">550 000 $</p>
              <a className="cta-jump" href="#zayavka">Оставить телефон</a>
            </div>

            <dl className="specs">
              {SPECS.map(([k, v]) => (
                <div className="spec" key={k}>
                  <dt>{k}</dt>
                  <dd className="num">{v}</dd>
                </div>
              ))}
            </dl>

            <section className="block">
              <h2>О доме</h2>
              <p>
                Практически новый дом премиум-класса с приватным двором на
                территории одного из самых известных курортных комплексов
                Иссык-Куля. Продаётся с мебелью и техникой: кухня полностью
                оборудована — варочная панель, холодильник, микроволновая печь,
                посуда. Заезжать можно сразу.
              </p>
            </section>

            <section className="block">
              <h2>Планировка</h2>
              <div className="grid2">
                <div>
                  <h3 className="key">Первый этаж</h3>
                  <ul className="ticks">
                    {FLOOR_1.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </div>
                <div>
                  <h3 className="key">Второй этаж</h3>
                  <ul className="ticks">
                    {FLOOR_2.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <section className="block">
              <h2>На территории комплекса</h2>
              <ul className="ticks cols">
                {RESORT.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </section>

            <section className="block">
              <h2>Фотографии</h2>
              <div className="gallery">
                {PHOTOS.slice(1).map((ph) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img key={ph.src} src={ph.src} alt={ph.alt}
                       width={ph.w} height={ph.h} loading="lazy" className="shot" />
                ))}
              </div>
            </section>

            <section className="block">
              <h2>Готовый арендный бизнес</h2>
              <p>
                Дом уже сдаётся посуточно через Airbnb, есть сложившаяся база
                постоянных гостей и своя история отзывов — почти все оценки
                5 из 5. Работает отдельный аккаунт в Instagram. Покупатель
                получает не просто дом, а действующий арендный продукт.
              </p>
              <p>
                Ставка мая — 200 $ в сутки за весь дом. Это тариф одного
                месяца, не средний по году: загрузку и доходность агент
                присылает отдельно, по запросу.
              </p>
              <p className="after">
                <a href={AIRBNB} target="_blank" rel="noopener noreferrer">
                  Объявление на Airbnb
                </a>{' '}— то же жильё, с отзывами гостей.
              </p>
            </section>

            <section className="block">
              <h2>Документы и расходы</h2>
              <dl className="specs">
                <div className="spec">
                  <dt>Документы</dt>
                  <dd>Красная книга, технический паспорт</dd>
                </div>
                <div className="spec">
                  <dt>Обслуживание, май–сентябрь</dt>
                  <dd className="num">≈ 210 $/мес</dd>
                </div>
                <div className="spec">
                  <dt>Обслуживание, октябрь–апрель</dt>
                  <dd className="num">≈ 140 $/мес</dd>
                </div>
              </dl>
              <p className="after">
                <a href={KP} download>Скачать презентацию объекта</a>{' '}
                <span className="key">PDF, 9 страниц</span>
              </p>
            </section>

            <section className="block">
              <h2>Видеообзор</h2>
              <p>
                Короткий обзор дома и территории — в Instagram:{' '}
                <a href={REEL} target="_blank" rel="noopener noreferrer">
                  смотреть видео
                </a>
                . Полный обзор, расчёт доходности и условия просмотра агент
                пришлёт после заявки.
              </p>
            </section>
          </div>

          <div className="aside">
            <div className="panel-card" id="zayavka">
              <h2>Оставьте телефон</h2>
              <p className="note">
                Агент перезвонит, пришлёт видеообзор и расчёт доходности,
                договорится о просмотре.
              </p>
              <ChaikaForm source={SOURCE} />
            </div>

            <div className="callout">
              <b>Позвонить сейчас</b>
              <span className="mini">Отдел продаж</span>
              {AGENCY_PHONES.map((p) => (
                <a key={p.href} href={p.href} className="mono">{p.display}</a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <CatalogFooter lang="ru" />
    </>
  );
}
