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
    siteName: "Платформа профессионалов",
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
              Платформа <span>профессионалов</span>
            </a>
            <p>Недвижимость Бишкека, только с действующим договором</p>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-foot">
          <div className="wrap">
            Объект попадает в каталог только при действующем договоре с
            собственником, а дата рядом с ценой — это дата, когда агент
            подтвердил, что цена и фотографии ещё в силе.
          </div>
        </footer>
      </body>
    </html>
  );
}
