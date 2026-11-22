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
              {/* Знак — не буква, а дом: три этажа окон в фирменном квадрате.
                  Буква в квадрате читается как заглушка, дом — как знак. */}
              <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
                <rect width="24" height="24" rx="6" fill="currentColor" />
                <g fill="#fff">
                  <rect x="7" y="6" width="3" height="3" rx="0.6" />
                  <rect x="12" y="6" width="5" height="3" rx="0.6" />
                  <rect x="7" y="11" width="3" height="3" rx="0.6" />
                  <rect x="12" y="11" width="5" height="3" rx="0.6" />
                  <rect x="7" y="16" width="3" height="2" rx="0.6" />
                  <rect x="12" y="16" width="5" height="2" rx="0.6" />
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
