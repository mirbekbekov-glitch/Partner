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
 * Почему страница не похожа на каталог. В каталог приходят выбирать из
 * многих объектов, и оформление там нарочно отходит в сторону. Сюда
 * приходят с баннера, ради одного дома, обычно с телефона и на минуту.
 * Поэтому здесь своя шапка, свой подвал и свой облик — см. landing.css, —
 * а переключателей языка и входа для агентов нет: покупателю они не нужны.
 *
 * Без языкового префикса — по той же причине, по какой текст только
 * русский: подписи интерфейса переводятся, а текст об объекте пишет агент
 * своими словами, и машинного перевода тут не будет (см. lib/i18n.ts).
 *
 * Всё, что написано ниже про дом, получено от агентства — из объявления и
 * из коммерческого предложения. Ничего не добавлено «для красоты»:
 * объявление о недвижимости — обещание покупателю.
 */
import type { Metadata } from 'next';
import { ChaikaForm } from '../ChaikaForm';
import { AGENCY_PHONES } from '@/lib/agency';
import { siteUrl } from '@/lib/site';
import './landing.css';

export const dynamic = 'force-dynamic';

/** Метка для поля source в заявке: по ней видно, что сработал печатный код. */
const SOURCE = 'chayka-qr';

const REEL = 'https://www.instagram.com/reel/DfjNYukOWEl/';

/** Объявление на Airbnb: подтверждение, что арендный бизнес не на словах. */
const AIRBNB = 'https://www.airbnb.ru/rooms/1420997659375471402';

/** Коммерческое предложение агентства — тот же дом, одним файлом. */
const KP = '/chaika/kp-dupleks-chaika-resort.pdf';

/** Первый номер отдела продаж: на него ведут кнопки звонка и WhatsApp. */
const MAIN_PHONE = AGENCY_PHONES[0];
const WHATSAPP = 'https://wa.me/' + MAIN_PHONE.href.replace(/\D/g, '');

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
 * Снимки для мозаики. Подписи описывают то, что на кадре, а не рекламируют:
 * alt читает экранный диктор и показывает браузер, когда картинка не
 * загрузилась, — приукрашивать тут некого и незачем.
 *
 * Первый кадр занимает два ряда, поэтому он вертикальный: горизонтальный в
 * высокой ячейке обрезался бы до полоски.
 */
const PHOTOS: { src: string; alt: string; cap: string; tall?: boolean }[] = [
  { src: '/chaika/vyhod-v-sad.webp', tall: true, cap: 'Выход во двор',
    alt: 'Обеденная зона у панорамной двери с выходом во двор' },
  { src: '/chaika/gostinaya.webp', cap: 'Гостиная',
    alt: 'Гостиная: два дивана, телевизор, в глубине кухня-столовая' },
  { src: '/chaika/kuhnya-stolovaya.webp', cap: 'Кухня-столовая',
    alt: 'Кухня со встроенной техникой и обеденный стол у окна' },
  { src: '/chaika/spalnya.webp', cap: 'Спальня',
    alt: 'Спальня с двуспальной кроватью и окном во всю стену' },
  { src: '/chaika/spalnya-kabinet.webp', cap: 'Спальня с балконом',
    alt: 'Спальня с рабочим столом и выходом на балкон' },
  { src: '/chaika/terrasa.webp', cap: 'Терраса второго этажа',
    alt: 'Крытая терраса второго этажа, за перилами деревья, пляж и озеро' },
  { src: '/chaika/kompleks.webp', cap: 'Улица комплекса',
    alt: 'Улица комплекса с высоты: ряды домов с зелёными дворами, '
       + 'на горизонте снежные горы' },
  { src: '/chaika/plyazh.webp', cap: 'Бухта у комплекса',
    alt: 'Песчаная бухта Иссык-Куля с навесами, за ней горный хребет' },
];

/** Строки бегущей ленты. */
const TICKER = [
  '178 м² и свой двор',
  '5 спален',
  'Мебель и техника в цене',
  'Пляж в нескольких шагах',
  'Красная книга и техпаспорт',
  'Тёплый дом круглый год',
  'Действующий Airbnb',
];

/** Короткие числа первого экрана. */
const CHIPS = ['178 м²', '5 спален', '2-я линия', 'участок 312,5 м²', 'Chaika Resort'];

const STATS: { num: string; title: string; note: string; solid?: boolean }[] = [
  { num: '178 м²', title: 'Площадь дома',
    note: 'Два этажа, 7 комнат, из них 5 спален' },
  { num: '312,5 м²', title: 'Свой двор',
    note: 'Приватный зелёный участок с выходом из гостиной' },
  { num: '2-я', title: 'Линия от озера',
    note: 'До песчаного пляжа — несколько шагов' },
  { num: '365', title: 'Дней в году', solid: true,
    note: 'Отапливается, подходит для жизни круглый год' },
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

/** Что внутри периметра курорта. */
const RESORT: { k: string; h: string; p: string }[] = [
  { k: 'Еда', h: 'Ресторан и бар на территории',
    p: 'Не нужно выезжать за пределы комплекса, чтобы поужинать.' },
  { k: 'Спорт', h: 'Теннисный корт, футбольное и баскетбольное поле',
    p: 'Площадки внутри периметра, в нескольких минутах от дома.' },
  { k: 'Дети', h: 'Детские площадки и ухоженная территория',
    p: 'Закрытый двор без транзитных машин: детей можно отпускать гулять.' },
  { k: 'Безопасность', h: 'Охрана и закрытая территория',
    p: 'Въезд по пропускам, бесплатная парковка у дома.' },
];

export default function ChaikaResortPage() {
  return (
    <div className="lp">
      {/* Unbounded — крупный шрифт заголовков этой страницы, и только её.
          Ссылкой, а не next/font: сборка идёт в сети, где Google Fonts
          недоступен. Если шрифт не загрузится, заголовки возьмут Manrope —
          он указан следующим в --display. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800&display=swap"
      />

      <header className="nav band">
        <div className="wrap">
          <a className="brand" href="#top">
            <span className="brand-mark" aria-hidden="true">L</span>
            <span>
              <span className="brand-name">LIBERTERRA</span>
              <span className="brand-sub">агентство недвижимости, Бишкек</span>
            </span>
          </a>
          <nav className="nav-links" aria-label="Разделы страницы">
            <a href="#dom">Дом</a>
            <a href="#foto">Фото</a>
            <a href="#kurort">Курорт</a>
            <a href="#biznes">Доход</a>
            <a href="#zayavka">Условия</a>
          </nav>
          <a className="btn btn-red btn-sm" href="#zayavka">Оставить телефон</a>
        </div>
      </header>

      <section className="hero band" id="top">
        <div className="wrap">
          <div className="hero-copy">
            <span className="eyebrow">Иссык-Куль</span>
            <h1>Дом у самого <span className="accent">пляжа</span></h1>
            <p className="lead">
              Двухэтажный дуплекс в закрытом курортном комплексе Chaika Resort.
              Полностью меблирован, с техникой, отапливается — заезжать можно
              сразу. И уже приносит доход на Airbnb.
            </p>
            <div className="chips">
              {CHIPS.map((c, i) => (
                <span key={c} className={i === 0 ? 'chip hot' : 'chip'}>{c}</span>
              ))}
            </div>
            <div className="cta-row">
              <a className="btn btn-red" href="#zayavka">Оставить телефон</a>
              <a className="btn btn-ghost" href="#foto">Смотреть фото</a>
            </div>
            <p className="coords">Иссык-Куль · пансионат Chaika Resort</p>
          </div>

          <div className="hero-visual">
            <div className="hero-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/chaika/dom-s-vysoty.webp" width={998} height={778}
                   fetchPriority="high"
                   alt="Дом с высоты: черепичная крыша, крытая терраса, мощёный двор,
                        за домом тополя и полоса озера" />
            </div>
            <div className="float-num">
              550 000 $<small>ПРОДАЖА</small>
            </div>
            <div className="float-card">
              <span className="k">Готовый доход</span>
              <span className="v">Сдаётся на Airbnb</span>
              <span className="s">База постоянных гостей, оценки 5 из 5</span>
            </div>
          </div>
        </div>
      </section>

      {/* Бегущая строка — украшение; для диктора она не нужна и только
          мешала бы, поэтому скрыта от него целиком.

          Список повторён дважды намеренно: лента едет ровно на половину
          своей ширины и в этот миг выглядит точно так же, как в начале, —
          поэтому шва не видно. */}
      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[...TICKER, ...TICKER].map((t, i) => <span key={i}>{t}</span>)}
        </div>
      </div>

      <section className="sec band" id="dom">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Объект</span>
            <h2>Дом, в который можно заехать завтра</h2>
            <p className="lead">
              Практически новый дом премиум-класса с приватным двором. Кухня
              полностью оборудована — варочная панель, холодильник,
              микроволновая печь, посуда. Мебель и техника входят в стоимость.
            </p>
          </div>

          <div className="stats">
            {STATS.map((s) => (
              <div className={s.solid ? 'stat solid' : 'stat'} key={s.title}>
                <span className="num">{s.num}</span>
                <h3>{s.title}</h3>
                <p>{s.note}</p>
              </div>
            ))}
          </div>

          <div className="floors">
            <div className="floor">
              <span className="k">Первый этаж</span>
              <h3>Общая часть и выход во двор</h3>
              <ul>{FLOOR_1.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div className="floor">
              <span className="k">Второй этаж</span>
              <h3>Спальни и балкон на озеро</h3>
              <ul>{FLOOR_2.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      <section className="sec band gallery-sec" id="foto">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Фотографии</span>
            <h2>Светло, просторно, всё уже на месте</h2>
          </div>
          <div className="mosaic">
            {PHOTOS.map((ph) => (
              <figure className={ph.tall ? 'shot tall' : 'shot'} key={ph.src}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ph.src} alt={ph.alt} loading="lazy" />
                <figcaption>{ph.cap}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="sec band" id="kurort">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Курорт Chaika Resort</span>
            <h2>Всё для отдыха — внутри периметра</h2>
            <p className="lead">
              Дом стоит на территории одного из самых известных курортных
              комплексов Иссык-Куля: песчаный пляж, вид на снежные вершины и
              закрытая охраняемая территория.
            </p>
          </div>
          <div className="cards">
            {RESORT.map((c) => (
              <div className="card" key={c.k}>
                <span className="k">{c.k}</span>
                <h3>{c.h}</h3>
                <p>{c.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec band dark-sec" id="biznes">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Инвестиция</span>
            <h2>Готовый арендный бизнес</h2>
            <p className="lead">
              Дом уже сдаётся посуточно через Airbnb, есть сложившаяся база
              постоянных гостей и своя история отзывов. Покупатель получает не
              просто дом, а работающий источник дохода с первого сезона.
            </p>
          </div>

          <div className="facts">
            <div className="fact">
              <span className="v">Airbnb</span>
              <p>
                Действующее объявление с отзывами гостей —{' '}
                <a href={AIRBNB} target="_blank" rel="noopener noreferrer">
                  посмотреть
                </a>
                .
              </p>
            </div>
            <div className="fact">
              <span className="v">VIP</span>
              <p>База постоянных гостей, почти все оценки 5 из 5.</p>
            </div>
            <div className="fact">
              <span className="v">200 $</span>
              <p>В сутки за весь дом — ставка мая.</p>
            </div>
          </div>

          <div className="caveat">
            <b>200 $ — ставка мая, а не доходность за год</b>
            <p>
              Май на Иссык-Куле не пик сезона, и выдавать тариф одного месяца
              за среднюю доходность было бы обманом. Загрузку по сезонам и
              расчёт агент присылает отдельно, по запросу.
            </p>
          </div>
        </div>
      </section>

      <section className="sec band offer" id="zayavka">
        <div className="offer-bg" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/chaika/plyazh.webp" alt="" loading="lazy" />
        </div>
        <div className="wrap">
          <div>
            <div className="sec-head" style={{ marginBottom: 0 }}>
              <span className="eyebrow">Условия и документы</span>
              <h2>550 000 $ — с мебелью, техникой и арендным бизнесом</h2>
              <p className="lead">
                Документы готовы, просмотр организуем в удобное время. Полный
                видеообзор и расчёт доходности пришлём после заявки.
              </p>
            </div>

            <div className="terms">
              <div className="term">
                <p className="k">Документы</p>
                <p>Красная книга и технический паспорт — готовы</p>
              </div>
              <div className="term">
                <p className="k">Обслуживание, май–сентябрь</p>
                <p><span className="num">≈ 210 $</span> в месяц</p>
              </div>
              <div className="term">
                <p className="k">Обслуживание, октябрь–апрель</p>
                <p><span className="num">≈ 140 $</span> в месяц</p>
              </div>
              <div className="term">
                <p className="k">Материалы</p>
                <p>
                  <a href={KP} download>Презентация объекта</a> (PDF, 9 страниц)
                  {' '}и{' '}
                  <a href={REEL} target="_blank" rel="noopener noreferrer">
                    видеообзор
                  </a>
                </p>
              </div>
            </div>
          </div>

          <div className="contact">
            <span className="k">Запись на просмотр</span>
            <h2>Оставьте телефон</h2>
            <p className="who">
              Агент перезвонит, пришлёт видеообзор и расчёт доходности,
              договорится о просмотре.
            </p>
            <ChaikaForm source={SOURCE} />
            <hr />
            <span className="k">Или позвоните сами</span>
            <div className="phones">
              {AGENCY_PHONES.map((p) => (
                <a key={p.href} href={p.href}>{p.display}</a>
              ))}
            </div>
            <p className="who">Отдел продаж Liberterra</p>
          </div>
        </div>
      </section>

      <footer className="band">
        <div className="wrap">
          <span>Chaika Resort, Иссык-Куль · дуплекс 178 м²</span>
          <span>Liberterra · агентство недвижимости, Бишкек</span>
        </div>
      </footer>

      {/* Нижняя полоса только на телефоне: человек стоит у баннера с
          телефоном в руке, и звонок для него — одно движение. */}
      <div className="callbar">
        <a className="btn btn-red" href={MAIN_PHONE.href}>Позвонить</a>
        <a className="btn btn-ghost" href={WHATSAPP}
           target="_blank" rel="noopener noreferrer">WhatsApp</a>
      </div>
    </div>
  );
}
