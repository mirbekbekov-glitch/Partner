import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DEFAULT_LANG, isLang } from '@/lib/i18n';
import { AGENCY_NAME } from '@/lib/agency';
import { SITE_URL } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  // Без metadataBase относительные canonical и og:image остаются
  // относительными, а мессенджер по такому пути картинку не найдёт и
  // покажет ссылку без превью.
  metadataBase: new URL(SITE_URL),
  title: { default: 'Liberterra — недвижимость в Бишкеке', template: '%s — Liberterra' },
  description: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
  // Превью при пересылке. Ссылками на объявления делятся в мессенджерах
  // чаще, чем ищут в поиске, поэтому og важнее части метатегов.
  // Картинку даёт app/opengraph-image.tsx; страницы объектов подменяют её
  // собственной фотографией.
  openGraph: {
    type: 'website',
    siteName: AGENCY_NAME,
    title: 'Liberterra — недвижимость в Бишкеке',
    description: 'Квартиры, дома и коммерческая недвижимость в Бишкеке.',
  },
  twitter: { card: 'summary_large_image' },
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
        {/* Подпись под значком на экране «Домой». Без неё iPhone берёт
            заголовок страницы и обрезает его: «Кабинет—Liber…». Сам значок
            лежит в app/apple-icon.png — iOS берёт именно apple-touch-icon,
            а favicon (app/icon.png) для рабочего стола не использует.

            Намеренно НЕ apple-mobile-web-app-capable: он открывает сайт
            отдельным окном без адресной строки, и это другое решение —
            его принимают, а не получают заодно с подписью. */}
        <meta name="apple-mobile-web-app-title" content="Liberterra" />

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
