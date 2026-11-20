import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Объекты в Бишкеке', template: '%s — Объекты в Бишкеке' },
  description: 'Квартиры, дома и коммерческая недвижимость в Бишкеке.',
};
// robots здесь больше нет: общий noindex закрыл бы и публичный каталог.
// Кабинет и вход закрывают себя сами — см. app/cabinet/layout.tsx и app/login.

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
