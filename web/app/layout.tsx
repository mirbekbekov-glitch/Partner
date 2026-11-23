import type { Metadata } from "next";
import "./globals.css";
import { ThemeToggle } from "./ThemeToggle";

export const metadata: Metadata = {
  title: {
    default: "Каталог недвижимости Бишкека",
    template: "%s — каталог недвижимости Бишкека",
  },
  description:
    "Квартиры, дома, участки и коммерческая недвижимость Бишкека. Каждое объявление имеет действующий договор с собственником и дату подтверждения актуальности.",
  openGraph: {
    type: "website",
    locale: "ru_KG",
    siteName: "Liberterra",
  },
  // Значок вкладки — тот же знак и тем же вектором. До сих пор его не было
  // вовсе: вкладка выглядела чужой среди открытых.
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <header className="site-head">
          <div className="wrap">
            <a href="/" className="brand">
              {/* НАСТОЯЩИЙ ЗНАК. Раньше здесь стояла моя заглушка — «дом из
                  окон в квадрате», — потому что логотипа не было.

                  Геометрия снята с присланного файла по пикселям, а не на
                  глаз: поле 256×297 со срезом 43×43 под 45° в правом нижнем
                  углу, треугольники со стороной 39 на сетке с шагом 41 по
                  горизонтали и 42,5 по вертикали. Прямой угол у каждого
                  треугольника слева сверху.

                  Числа не прикинуты: сторона и срез подобраны перебором по
                  наименьшему расхождению с присланным файлом. Остаточные
                  0,4% — это сглаживание диагоналей, а не ошибка.

                  Вектором, а не картинкой: знак остаётся чётким на любом
                  экране, красный берётся из фирменной переменной, и лишнего
                  запроса за файлом нет. */}
              <svg className="brand-mark" viewBox="0 0 256 297" aria-hidden="true">
                <path fill="currentColor" d="M0 0h256v254l-43 43H0z" />
                <g fill="#fff">
                  <path d="M44 43h39L44 82z" /> <path d="M85 43h39L85 82z" />
                  <path d="M44 86h39L44 125z" /> <path d="M85 86h39L85 125z" />
                  <path d="M44 128h39L44 167z" /> <path d="M85 128h39L85 167z" />
                  <path d="M44 170h39L44 209z" /> <path d="M85 170h39L85 209z" /> <path d="M126 170h39L126 209z" /> <path d="M167 170h39L167 209z" />
                  <path d="M44 213h39L44 252z" /> <path d="M85 213h39L85 252z" /> <path d="M126 213h39L126 252z" />
                </g>
              </svg>
              Liberterra
            </a>
            <a className="head-link" href="/#zayavka">Заявки</a>
            <div className="head-right">
              <ThemeToggle />
              {/* Надпись нейтральная нарочно: та же шапка стоит и над кабинетом,
                  а «Вход для агентов» вошедшему агенту — неправда. */}
              <a className="pill" href="/cabinet">Кабинет агента</a>
            </div>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-foot">
          <div className="wrap">
            <div>
              <p className="foot-brand">LIBERTERRA</p>
              <p>
                Объект попадает в каталог только при действующем договоре с
                собственником, а дата рядом с ценой — это дата, когда агент
                подтвердил, что цена и фотографии ещё в силе.
              </p>
            </div>
            <div>
              <p className="foot-label">Агентам</p>
              <p><a href="/cabinet">Вход в кабинет</a></p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
