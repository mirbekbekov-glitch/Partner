import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LANG, isLang } from '@/lib/i18n';
import { SESSION_COOKIE } from '@/lib/db/session';

/**
 * Две разные задачи под одной крышей.
 *
 * Кабинету нужен хотя бы признак входа — его видно по cookie. Публичному
 * каталогу нужен только язык.
 *
 * ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ ПОДЛИННОСТЬ СЕССИИ, и это сознательно. Наличие
 * cookie — дешёвый отсев: он избавляет от отрисовки кабинета тому, кто
 * вовсе не входил. Настоящая проверка идёт в гейте кабинета и в каждом
 * действии слоя доступа, где сессия сверяется с базой. Подделать cookie
 * и попасть дальше гейта нельзя: токена нет в базе — нет и агента.
 *
 * Раньше здесь обновлялась сессия Supabase, то есть на КАЖДЫЙ переход по
 * кабинету уходил сетевой вызов. Теперь не уходит ни одного.
 *
 * Язык кладётся в заголовок запроса, потому что <html lang> стоит в
 * корневом макете, а тот про участок [lang] ничего не знает: макеты
 * получают параметры своего уровня, не вложенного. Без правильного
 * lang экранный диктор читает китайский текст по-русски, а браузер
 * предлагает перевести страницу, уже открытую на нужном языке.
 */
const PRIVATE = ['/cabinet', '/login', '/auth'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PRIVATE.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Вход и приём ссылки должны открываться как раз без сессии.
    const open = pathname === '/login' || pathname.startsWith('/auth/');
    if (open) return NextResponse.next();

    if (!request.cookies.get(SESSION_COOKIE)) {
      const login = new URL('/login', request.url);
      login.searchParams.set('next', pathname);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  const first = pathname.split('/')[1];
  const headers = new Headers(request.headers);
  headers.set('x-lang', isLang(first) ? first : DEFAULT_LANG);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Перечислением, а не «всё кроме статики»: под раздачу иначе попадают
  // картинки и шрифты, которым ни сессия, ни язык не нужны.
  matcher: [
    '/', '/cabinet/:path*', '/login', '/auth/:path*', '/objects/:path*',
    '/ky', '/ru', '/en', '/zh',
    '/ky/:path*', '/ru/:path*', '/en/:path*', '/zh/:path*',
  ],
};
