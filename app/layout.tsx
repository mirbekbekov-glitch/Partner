import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Кабинет агента',
  description: 'CRM платформы профессионалов',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
