import type { Metadata } from "next";
import "./globals.css";

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
              <i aria-hidden="true">L</i>
              Liberterra <span>Бишкек</span>
            </a>
            <div className="head-right">
              {/* Надпись нейтральная нарочно: та же шапка стоит и над кабинетом,
                  а «Вход для агентов» вошедшему агенту — неправда. */}
              <a className="pill ghost" href="/cabinet">Кабинет агента</a>
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
