import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DEFAULT_LANG, isLang } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Liberterra — недвижимость в Бишкеке', template: '%s — Liberterra' },
  description: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
};
// robots здесь больше нет: общий noindex закрыл бы и публичный каталог.
// Кабинет и вход закрывают себя сами — см. app/cabinet/layout.tsx и app/login.

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Язык ставит middleware: корневой макет не видит участок [lang].
  const raw = (await headers()).get('x-lang');
  const lang = isLang(raw) ? raw : DEFAULT_LANG;

  return (
    <html lang={lang}>
      <head>
        {/* Выбранная тема применяется ДО отрисовки: React сделал бы это
            после, и страница успевала бы моргнуть светлой перед тёмной.
            Скрипт крошечный и синхронный намеренно. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');" +
              "if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
        {/* Manrope — шрифт дизайн-системы. Ссылкой, а не next/font: сборка
            идёт в сети, где Google Fonts недоступен, а браузер читателя
            загрузит его сам. Запасные шрифты заданы в globals.css. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap"
        />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
