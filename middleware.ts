import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { DEFAULT_LANG, isLang } from '@/lib/i18n';

/**
 * Две разные задачи под одной крышей.
 *
 * Кабинету нужна свежая сессия — за ней идём в Supabase. Публичному
 * каталогу нужен только язык, и сетевого вызова там быть не должно:
 * это запрос на каждый просмотр страницы случайным посетителем.
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
    return updateSession(request);
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
