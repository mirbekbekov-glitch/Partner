import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Liberterra — недвижимость в Бишкеке', template: '%s — Liberterra' },
  description: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
};
// robots здесь больше нет: общий noindex закрыл бы и публичный каталог.
// Кабинет и вход закрывают себя сами — см. app/cabinet/layout.tsx и app/login.

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head>
        {/* Manrope — шрифт дизайн-системы. Ссылкой, а не next/font: сборка
            идёт в сети, где Google Fonts недоступен, а браузер читателя
            загрузит его сам. Запасные шрифты заданы в globals.css. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
